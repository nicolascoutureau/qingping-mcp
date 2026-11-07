#!/usr/bin/env node
/**
 * index.ts — Serveur MCP Qingping (stdio).
 *
 * Outils :
 *   qingping_current   mesures actuelles (+ niveaux) de tous les capteurs ou d'un seul
 *   qingping_history   historique : résumé par métrique (min/max/moyenne, temps au-dessus des seuils) + série optionnelle
 *   qingping_alerts    alertes déclenchées (seuils réglés dans l'app Qingping+)
 *   qingping_set_intervals  intervalles de mesure / d'envoi au cloud
 *
 * Variables d'environnement : QINGPING_APP_KEY, QINGPING_APP_SECRET
 * (developer.qingping.co → Access management).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { METRIC_KEYS, QingpingClient, normalizeMac, type Device, type MetricKey } from './client.js';
import { assess, downsample, summarize, withUnits } from './analysis.js';

// Clés : variables d'environnement, sinon le fichier .env à la racine du projet.
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

/** Trouve les capteurs visés : MAC exacte, ou nom (sans casse, partiel). Sans filtre : tous. */
async function resolveDevices(device?: string): Promise<Device[]> {
  const all = await client.listDevices();
  if (!all.length) throw new Error("Aucun appareil lié à ce compte Qingping.");
  if (!device) return all;
  const q = device.trim().toLowerCase();
  const mac = normalizeMac(device);
  const found = all.filter((d) => d.mac === mac || (d.name ?? '').toLowerCase().includes(q));
  if (!found.length) {
    throw new Error(
      `Aucun appareil ne correspond à « ${device} ». Appareils : ${all.map((d) => `${d.name ?? '?'} (${d.mac})`).join(', ')}`,
    );
  }
  return found;
}

/** Un seul capteur : celui demandé, ou l'unique capteur du compte. */
async function resolveOne(device?: string): Promise<Device> {
  const found = await resolveDevices(device);
  if (found.length > 1) {
    throw new Error(
      `Plusieurs appareils correspondent ; précisez « device » : ${found.map((d) => `${d.name ?? '?'} (${d.mac})`).join(', ')}`,
    );
  }
  return found[0];
}

/** Fenêtre de temps en secondes Unix, depuis start/end ISO ou les N dernières heures. */
function window(args: { hours?: number; start?: string; end?: string }): [number, number] {
  const parse = (s: string, label: string) => {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) throw new Error(`Date « ${label} » illisible : ${s}`);
    return Math.floor(t / 1000);
  };
  const end = args.end ? parse(args.end, 'end') : Math.floor(Date.now() / 1000);
  const start = args.start ? parse(args.start, 'start') : end - Math.round((args.hours ?? 24) * 3600);
  if (start >= end) throw new Error('« start » doit précéder « end ».');
  return [start, end];
}

const deviceParam = z
  .string()
  .optional()
  .describe("Nom ou adresse MAC de l'appareil. Facultatif s'il n'y en a qu'un sur le compte.");
const timeParams = {
  hours: z.number().positive().max(24 * 90).optional().describe('Les N dernières heures (défaut 24). Ignoré si start est donné.'),
  start: z.string().optional().describe('Début, ISO 8601 (ex. 2026-11-06T22:00:00+01:00).'),
  end: z.string().optional().describe('Fin, ISO 8601. Défaut : maintenant.'),
};

const server = new McpServer({ name: 'qingping', version: '0.1.0' });

server.registerTool(
  'qingping_current',
  {
    title: 'Mesures actuelles',
    description:
      "Dernières mesures des capteurs Qingping (CO₂, PM2.5, PM10, tVOC, température, humidité, batterie…) avec un niveau lisible (bon / élevé — aérer…). " +
      "readingAt indique l'heure de la mesure : le capteur n'envoie au cloud qu'à chaque intervalle de report (souvent 15 min).",
    inputSchema: { device: deviceParam },
    annotations: { readOnlyHint: true },
  },
  async ({ device }) => {
    try {
      const devices = await resolveDevices(device);
      return ok(
        devices.map((d) => ({
          name: d.name,
          mac: d.mac,
          model: d.model,
          offline: d.offline,
          readingAt: d.readingAt,
          readings: withUnits(d.readings),
          assessment: assess(d.readings),
          ...(d.unhealthy.length ? { sensorWarnings: d.unhealthy } : {}),
          ...(Object.keys(d.readings).length
            ? {}
            : {
                note:
                  "Aucune mesure reçue par le cloud Qingping pour cet appareil. Il envoie probablement ses données ailleurs (appairé dans Mi Home, ou une config MQTT privée) : le réappairer dans l'app Qingping+ / Qingping IoT.",
              }),
          reportIntervalMin: d.reportIntervalS ? d.reportIntervalS / 60 : null,
          collectIntervalMin: d.collectIntervalS ? d.collectIntervalS / 60 : null,
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'qingping_history',
  {
    title: 'Historique des mesures',
    description:
      "Historique d'un capteur Qingping sur une période. Renvoie par métrique min / max / moyenne / première / dernière valeur, " +
      "l'heure du min et du max, et le temps passé au-dessus des seuils (CO₂ > 1000 et > 1500 ppm, PM2.5 > 15 et > 35, humidité > 60 et > 70 %). " +
      'Avec max_points > 0, ajoute la série (moyennée par tranches) pour tracer une courbe.',
    inputSchema: {
      device: deviceParam,
      ...timeParams,
      metrics: z
        .array(z.enum(METRIC_KEYS))
        .optional()
        .describe('Limiter à ces métriques (ex. ["co2","pm25"]). Défaut : toutes.'),
      max_points: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe('Nombre max de points de la série renvoyée (0 = résumé seul, défaut 0).'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ device, hours, start, end, metrics, max_points }) => {
    try {
      const d = await resolveOne(device);
      const [s, e] = window({ hours, start, end });
      const samples = await client.history(d.mac, s, e);
      const keys = metrics as MetricKey[] | undefined;
      return ok({
        device: { name: d.name, mac: d.mac, model: d.model },
        ...summarize(samples, keys),
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
    title: 'Alertes déclenchées',
    description:
      "Alertes déclenchées par un capteur Qingping sur une période (seuils réglés dans l'app Qingping+, ex. CO₂ > 1000 ppm).",
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
    title: "Régler les intervalles",
    description:
      "Change l'intervalle de mesure (collect) et d'envoi au cloud (report) d'un capteur Qingping. " +
      "Un report court donne des données plus fraîches mais use plus la batterie si l'appareil n'est pas sur secteur.",
    inputSchema: {
      device: deviceParam,
      report_interval_min: z.number().int().min(1).max(1440).describe("Envoi au cloud toutes les N minutes."),
      collect_interval_min: z.number().int().min(1).max(1440).describe('Mesure toutes les N minutes.'),
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
        note: "Pris en compte par l'appareil à son prochain envoi au cloud.",
      });
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
