/**
 * analysis.ts — Lecture « humaine » des mesures : niveaux, résumés d'historique.
 * Repères : OMS 2021 (PM2.5 24 h 15 µg/m³, PM10 24 h 45 µg/m³), CO₂ 1000 ppm
 * (confinement), humidité 40–60 %.
 */

import type { MetricKey, Readings, Sample } from './client.js';

export const UNITS: Partial<Record<MetricKey, string>> = {
  temperature: '°C',
  prob_temperature: '°C',
  humidity: '%',
  co2: 'ppm',
  co2_percent: '%',
  pm25: 'µg/m³',
  pm10: 'µg/m³',
  tvoc: 'ppb',
  tvoc_index: 'index (100 = référence)',
  noise: 'dB',
  pressure: 'kPa',
  battery: '%',
  signal: 'dBm',
};

type Level = { max: number; label: string };

const SCALES: Partial<Record<MetricKey, Level[]>> = {
  co2: [
    { max: 800, label: 'bon' },
    { max: 1000, label: 'correct' },
    { max: 1500, label: 'élevé — aérer' },
    { max: Infinity, label: 'très élevé — aérer maintenant' },
  ],
  pm25: [
    { max: 15, label: 'bon' },
    { max: 35, label: 'moyen' },
    { max: 75, label: 'mauvais' },
    { max: Infinity, label: 'très mauvais' },
  ],
  pm10: [
    { max: 45, label: 'bon' },
    { max: 100, label: 'moyen' },
    { max: Infinity, label: 'mauvais' },
  ],
  humidity: [
    { max: 30, label: 'trop sec' },
    { max: 40, label: 'sec' },
    { max: 60, label: 'bon' },
    { max: 70, label: 'humide' },
    { max: Infinity, label: 'très humide — risque de moisissures' },
  ],
  tvoc_index: [
    { max: 150, label: 'bon' },
    { max: 250, label: 'moyen' },
    { max: Infinity, label: 'élevé' },
  ],
};

export function assess(readings: Readings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, scale] of Object.entries(SCALES) as [MetricKey, Level[]][]) {
    const v = readings[key];
    if (v === undefined) continue;
    out[key] = scale.find((l) => v <= l.max)!.label;
  }
  return out;
}

/** Ajoute l'unité à chaque valeur (« 1068 ppm »). */
export function withUnits(readings: Readings): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, v] of Object.entries(readings) as [MetricKey, number][]) {
    const unit = UNITS[key];
    out[key] = unit ? `${v} ${unit}` : v;
  }
  return out;
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Seuils pour lesquels on compte le temps passé au-dessus. */
const THRESHOLDS: Partial<Record<MetricKey, number[]>> = {
  co2: [1000, 1500],
  pm25: [15, 35],
  humidity: [60, 70],
};

export interface MetricSummary {
  unit?: string;
  min: number;
  max: number;
  avg: number;
  first: number;
  last: number;
  minAt: string;
  maxAt: string;
  minutesAbove?: Record<string, number>;
}

export function summarize(samples: Sample[], metrics?: MetricKey[]) {
  const intervalS = median(samples.slice(1).map((s, i) => s.ts - samples[i].ts)) || 0;
  const keys = new Set<MetricKey>();
  for (const s of samples) for (const k of Object.keys(s.readings) as MetricKey[]) keys.add(k);
  const summary: Partial<Record<MetricKey, MetricSummary>> = {};
  for (const key of keys) {
    if (metrics && !metrics.includes(key)) continue;
    const pts = samples.filter((s) => s.readings[key] !== undefined);
    if (!pts.length) continue;
    const vals = pts.map((s) => s.readings[key]!);
    let iMin = 0;
    let iMax = 0;
    vals.forEach((v, i) => {
      if (v < vals[iMin]) iMin = i;
      if (v > vals[iMax]) iMax = i;
    });
    const m: MetricSummary = {
      unit: UNITS[key],
      min: vals[iMin],
      max: vals[iMax],
      avg: round(vals.reduce((a, b) => a + b, 0) / vals.length),
      first: vals[0],
      last: vals[vals.length - 1],
      minAt: pts[iMin].at,
      maxAt: pts[iMax].at,
    };
    const th = THRESHOLDS[key];
    if (th && intervalS) {
      m.minutesAbove = Object.fromEntries(
        th.map((t) => [`>${t}`, Math.round((vals.filter((v) => v > t).length * intervalS) / 60)]),
      );
    }
    summary[key] = m;
  }
  return {
    samples: samples.length,
    from: samples[0]?.at ?? null,
    to: samples[samples.length - 1]?.at ?? null,
    sampleIntervalMin: intervalS ? round(intervalS / 60) : null,
    metrics: summary,
  };
}

/** Réduit une série à `maxPoints` points (moyenne par tranche). */
export function downsample(samples: Sample[], maxPoints: number, metrics?: MetricKey[]) {
  const pick = (r: Readings) => {
    const out: Readings = {};
    for (const [k, v] of Object.entries(r) as [MetricKey, number][]) {
      if (!metrics || metrics.includes(k)) out[k] = v;
    }
    return out;
  };
  if (samples.length <= maxPoints) return samples.map((s) => ({ at: s.at, ...pick(s.readings) }));
  const size = Math.ceil(samples.length / maxPoints);
  const out: Array<Record<string, string | number>> = [];
  for (let i = 0; i < samples.length; i += size) {
    const chunk = samples.slice(i, i + size);
    const sums: Record<string, { s: number; n: number }> = {};
    for (const c of chunk) {
      for (const [k, v] of Object.entries(pick(c.readings))) {
        sums[k] ??= { s: 0, n: 0 };
        sums[k].s += v;
        sums[k].n += 1;
      }
    }
    const row: Record<string, string | number> = { at: chunk[0].at };
    for (const [k, { s, n }] of Object.entries(sums)) row[k] = round(s / n);
    out.push(row);
  }
  return out;
}
