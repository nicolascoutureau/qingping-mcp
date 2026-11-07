#!/usr/bin/env node
/**
 * index.ts — Qingping MCP server (stdio).
 *
 * Tools:
 *   qingping_current        latest readings (+ plain-language levels) of every sensor or of one
 *   qingping_history        history: per-metric summary (min/max/avg, time above thresholds) + optional series
 *   qingping_alerts         triggered alerts (thresholds set in the Qingping app)
 *   qingping_set_intervals  collect / report-to-cloud intervals
 *
 * Environment: QINGPING_APP_KEY, QINGPING_APP_SECRET
 * (developer.qingping.co → Access management).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { METRIC_KEYS, QingpingClient, normalizeMac, type Device, type MetricKey } from './client.js';
import { assess, coverage, downsample, freshness, summarize, withUnits } from './analysis.js';

// Keys: environment variables, otherwise the .env file at the project root.
if (!process.env.QINGPING_APP_KEY || !process.env.QINGPING_APP_SECRET) {
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const client = new QingpingClient(process.env.QINGPING_APP_KEY ?? '', process.env.QINGPING_APP_SECRET ?? '');

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

const describeDevices = (list: Device[]) => list.map((d) => `${d.name ?? '?'} (${d.mac})`).join(', ');

/** Target sensors: exact MAC, or name (case-insensitive, partial). No filter: all of them. */
async function resolveDevices(device?: string): Promise<Device[]> {
  const all = await client.listDevices();
  if (!all.length) throw new Error('No device is bound to this Qingping account.');
  if (!device) return all;
  const q = device.trim().toLowerCase();
  const mac = normalizeMac(device);
  const found = all.filter((d) => d.mac === mac || (d.name ?? '').toLowerCase().includes(q));
  if (!found.length) throw new Error(`No device matches "${device}". Devices: ${describeDevices(all)}`);
  return found;
}

/** A single sensor: the one asked for, or the only sensor of the account. */
async function resolveOne(device?: string): Promise<Device> {
  const found = await resolveDevices(device);
  if (found.length > 1) {
    throw new Error(`Several devices match; specify "device": ${describeDevices(found)}`);
  }
  return found[0];
}

/** Time window in Unix seconds, from ISO start/end or the last N hours. */
function window(args: { hours?: number; start?: string; end?: string }): [number, number] {
  const parse = (s: string, label: string) => {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) throw new Error(`Unreadable "${label}" date: ${s}`);
    return Math.floor(t / 1000);
  };
  const end = args.end ? parse(args.end, 'end') : Math.floor(Date.now() / 1000);
  const start = args.start ? parse(args.start, 'start') : end - Math.round((args.hours ?? 24) * 3600);
  if (start >= end) throw new Error('"start" must be before "end".');
  return [start, end];
}

const deviceParam = z
  .string()
  .optional()
  .describe('Device name or MAC address. Optional when the account has a single device.');
const timeParams = {
  hours: z
    .number()
    .positive()
    .max(24 * 90)
    .optional()
    .describe('The last N hours (default 24). Ignored when start is given.'),
  start: z.string().optional().describe('Start, ISO 8601 (e.g. 2026-11-06T22:00:00+01:00).'),
  end: z.string().optional().describe('End, ISO 8601. Default: now.'),
};

const server = new McpServer({ name: 'qingping', version: '0.1.0' });

server.registerTool(
  'qingping_current',
  {
    title: 'Current readings',
    description:
      'Latest readings of Qingping sensors (CO₂, PM2.5, PM10, tVOC, temperature, humidity, battery…) with a plain-language level (good / high — ventilate…). ' +
      'readingAt / ageMin give the time and age of the reading: the sensor only sends to the cloud once per report interval (often 15 min). ' +
      'staleWarning appears when the reading is late relative to that interval.',
    inputSchema: { device: deviceParam },
    annotations: { readOnlyHint: true },
  },
  async ({ device }) => {
    try {
      const devices = await resolveDevices(device);
      const nowS = Math.floor(Date.now() / 1000);
      return ok(
        devices.map((d) => {
          const fresh = freshness(d.readingTs, d.reportIntervalS, nowS);
          return {
          name: d.name,
          mac: d.mac,
          model: d.model,
          offline: d.offline,
          readingAt: d.readingAt,
          ageMin: fresh.ageMin,
          ...(fresh.stale && d.readingTs
            ? {
                staleWarning:
                  `Reading is ${fresh.ageMin} min old while the sensor should report every ${d.reportIntervalS ? d.reportIntervalS / 60 : '?'} min: ` +
                  'these values may not describe the air right now. The sensor may no longer reach the cloud (Wi-Fi, Internet, power).',
              }
            : {}),
          readings: withUnits(d.readings),
          assessment: assess(d.readings),
          ...(d.unhealthy.length ? { sensorWarnings: d.unhealthy } : {}),
          ...(Object.keys(d.readings).length
            ? {}
            : {
                note:
                  'The Qingping cloud has no reading for this device: it is not reaching the cloud. ' +
                  'If the date/time on its screen is wrong (e.g. 2015), it is on Wi-Fi but has no Internet access: reset its Wi-Fi and pair it again in the app.',
              }),
          reportIntervalMin: d.reportIntervalS ? d.reportIntervalS / 60 : null,
          collectIntervalMin: d.collectIntervalS ? d.collectIntervalS / 60 : null,
          };
        }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'qingping_history',
  {
    title: 'Reading history',
    description:
      'History of a Qingping sensor over a period. Returns, per metric, min / max / average / first / last value, ' +
      'the time of the min and max, and the minutes spent above thresholds (CO₂ > 1000 and > 1500 ppm, PM2.5 > 15 and > 35, humidity > 60 and > 70 %). ' +
      'With max_points > 0, also returns the series (averaged per bucket) to draw a chart. ' +
      'coverage gives the share of the period actually measured: an empty or partial history means "no data", not "nothing to report".',
    inputSchema: {
      device: deviceParam,
      ...timeParams,
      metrics: z
        .array(z.enum(METRIC_KEYS))
        .optional()
        .describe('Restrict to these metrics (e.g. ["co2","pm25"]). Default: all.'),
      max_points: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe('Max number of points in the returned series (0 = summary only, default 0).'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ device, hours, start, end, metrics, max_points }) => {
    try {
      const d = await resolveOne(device);
      const [s, e] = window({ hours, start, end });
      const samples = await client.history(d.mac, s, e);
      const keys = metrics as MetricKey[] | undefined;
      const summary = summarize(samples, keys);
      const intervalS = summary.sampleIntervalMin ? summary.sampleIntervalMin * 60 : d.collectIntervalS;
      const cov = coverage(samples, s, e, intervalS);
      let note: string | undefined;
      if (!samples.length) {
        note =
          'No readings in this period: the sensor sent nothing to the cloud (offline, Wi-Fi without Internet, or not yet connected). ' +
          'This is not "nothing to report": nothing is known about this period.' +
          (d.readingAt ? ` Latest known reading: ${d.readingAt}.` : '');
      } else if (cov.percent < 80) {
        note =
          `Partial data: ${cov.percent}% of the period covered (largest gap: ${cov.largestGapMin} min). ` +
          'Min / max / minutes above thresholds only describe the measured part.';
      }
      return ok({
        device: { name: d.name, mac: d.mac, model: d.model },
        ...(note ? { note } : {}),
        coverage: cov,
        ...summary,
        ...(max_points ? { series: downsample(samples, max_points, keys) } : {}),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'qingping_alerts',
  {
    title: 'Triggered alerts',
    description:
      'Alerts triggered by a Qingping sensor over a period (thresholds set in the Qingping app, e.g. CO₂ > 1000 ppm).',
    inputSchema: { device: deviceParam, ...timeParams },
    annotations: { readOnlyHint: true },
  },
  async ({ device, hours, start, end }) => {
    try {
      const d = await resolveOne(device);
      const [s, e] = window({ hours, start, end });
      const events = await client.events(d.mac, s, e);
      return ok({ device: { name: d.name, mac: d.mac }, count: events.length, events });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'qingping_set_intervals',
  {
    title: 'Set intervals',
    description:
      'Changes the measurement (collect) and cloud upload (report) intervals of a Qingping sensor. ' +
      'A short report interval gives fresher data but drains the battery faster when the device is not plugged in.',
    inputSchema: {
      device: deviceParam,
      report_interval_min: z.number().int().min(1).max(1440).describe('Upload to the cloud every N minutes.'),
      collect_interval_min: z.number().int().min(1).max(1440).describe('Measure every N minutes.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ device, report_interval_min, collect_interval_min }) => {
    try {
      const d = await resolveOne(device);
      await client.updateSettings([d.mac], report_interval_min * 60, collect_interval_min * 60);
      return ok({
        device: { name: d.name, mac: d.mac },
        reportIntervalMin: report_interval_min,
        collectIntervalMin: collect_interval_min,
        note: 'Applied by the device at its next upload to the cloud.',
      });
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
