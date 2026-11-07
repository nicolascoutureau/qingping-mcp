/**
 * client.ts — Client de l'Open API Qingping (developer.qingping.co).
 *
 *   POST https://oauth.cleargrass.com/oauth2/token        (client_credentials, Basic appKey:appSecret)
 *   GET  https://apis.cleargrass.com/v1/apis/devices         appareils + dernière mesure
 *   GET  https://apis.cleargrass.com/v1/apis/devices/data    historique (start_time / end_time en s)
 *   GET  https://apis.cleargrass.com/v1/apis/devices/events  alertes déclenchées
 *   PUT  https://apis.cleargrass.com/v1/apis/devices/settings intervalles de report / mesure
 *
 * Chaque appel porte `timestamp` en millisecondes (comme les SDK officiels).
 * Ni la clé, ni le secret, ni le token n'apparaissent dans un message d'erreur.
 */

export const OAUTH_URL = 'https://oauth.cleargrass.com/oauth2/token';
export const API_URL = 'https://apis.cleargrass.com/v1/apis';
const SCOPE = 'device_full_access';
const TIMEOUT_MS = 20_000;
const TOKEN_MARGIN_MS = 5 * 60_000;
const PAGE_SIZE = 50;
const HISTORY_PAGE_SIZE = 200;
const MAX_PAGES = 100;

export const METRIC_KEYS = [
  'temperature',
  'prob_temperature',
  'humidity',
  'co2',
  'co2_percent',
  'pm25',
  'pm10',
  'tvoc',
  'tvoc_index',
  'noise',
  'pressure',
  'battery',
  'signal',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type Readings = Partial<Record<MetricKey, number>>;

export interface Device {
  mac: string;
  name: string | null;
  model: string | null;
  productId: number | null;
  version: string | null;
  offline: boolean;
  reportIntervalS: number | null;
  collectIntervalS: number | null;
  /** Date de la dernière mesure (ISO), null si absente. */
  readingAt: string | null;
  readings: Readings;
  /** Capteurs signalés anormaux (status 1) ou en préchauffage (status 2). */
  unhealthy: string[];
}

export interface Sample {
  at: string;
  ts: number; // secondes
  readings: Readings;
}

export interface AlertEvent {
  at: string | null;
  metric: string | null;
  operator: string | null;
  threshold: number | null;
  status: number | null;
  readings: Readings;
}

export class QingpingError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'QingpingError';
  }
}

type Json = Record<string, unknown>;
export type RequestFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; body: string }>;

const fetchRequest: RequestFn = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, body: await res.text() };
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
/** Secondes Unix → ISO 8601 à l'heure locale de la machine, avec décalage (2026-11-07T21:13:00+01:00). */
export function iso(s: number | null): string | null {
  if (!s || s <= 0) return null;
  const d = new Date(s * 1000);
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Message d'erreur Qingping, court et sans rien qui ressemble à un secret. */
function describe(body: string): string {
  const j = obj(parseJson(body));
  const m = j.msg ?? j.message ?? j.error_description ?? j.error ?? '';
  return String(typeof m === 'object' ? JSON.stringify(m) : m)
    .replace(/[A-Za-z0-9_-]{24,}/g, '…')
    .slice(0, 160);
}

/** Lit un bloc `data` ({ temperature: { value, status } ... }). */
export function parseReadings(raw: unknown): { readings: Readings; unhealthy: string[]; ts: number | null } {
  const data = obj(raw);
  const readings: Readings = {};
  const unhealthy: string[] = [];
  for (const key of METRIC_KEYS) {
    const entry = obj(data[key]);
    const value = num(entry.value);
    if (value === null) continue;
    const status = num(entry.status);
    // Pour la batterie, status = état de charge, pas santé du capteur.
    if (key !== 'battery' && (status === 1 || status === 2)) {
      unhealthy.push(`${key}${status === 2 ? ' (préchauffage)' : ' (anormal)'}`);
    }
    readings[key] = value;
  }
  return { readings, unhealthy, ts: num(obj(data.timestamp).value) };
}

export function normalizeMac(raw: string): string {
  return raw.replace(/[^0-9a-f]/gi, '').toUpperCase();
}

export function parseDevice(raw: unknown): Device | null {
  const info = obj(obj(raw).info);
  const mac = str(info.mac);
  if (!mac) return null;
  const product = obj(info.product);
  const setting = obj(info.setting);
  const { readings, unhealthy, ts } = parseReadings(obj(raw).data);
  const positive = (v: unknown) => {
    const n = num(v);
    return n && n > 0 ? n : null;
  };
  return {
    mac: normalizeMac(mac),
    name: str(info.name),
    model: str(product.en_name) ?? str(product.name),
    productId: num(product.id),
    version: str(info.version),
    offline: obj(info.status).offline === true,
    reportIntervalS: positive(setting.report_interval),
    collectIntervalS: positive(setting.collect_interval),
    readingAt: iso(ts),
    readings,
    unhealthy,
  };
}

export class QingpingClient {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly appKey: string,
    private readonly appSecret: string,
    private readonly request: RequestFn = fetchRequest,
    private readonly now: () => number = Date.now,
  ) {}

  private async send(url: string, init: Parameters<RequestFn>[1]) {
    try {
      return await this.request(url, init);
    } catch (err) {
      const e = err as { name?: string; code?: string; cause?: { code?: string } };
      const reason = e?.name === 'TimeoutError' ? 'délai dépassé' : e?.cause?.code ?? e?.code ?? e?.name ?? 'erreur';
      throw new QingpingError(`Cloud Qingping injoignable (${reason})`);
    }
  }

  private async getToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - TOKEN_MARGIN_MS) return this.token.value;
    this.pending ??= this.requestToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async requestToken(): Promise<string> {
    if (!this.appKey || !this.appSecret) {
      throw new QingpingError(
        'QINGPING_APP_KEY et QINGPING_APP_SECRET ne sont pas définies (developer.qingping.co → Access management).',
      );
    }
    const basic = Buffer.from(`${this.appKey}:${this.appSecret}`).toString('base64');
    const res = await this.send(OAUTH_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString(),
    });
    if (res.status !== 200) {
      const detail = describe(res.body);
      throw new QingpingError(
        `App Key / App Secret refusées (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
        res.status,
      );
    }
    const j = obj(parseJson(res.body));
    const value = str(j.access_token);
    if (!value) throw new QingpingError('Réponse OAuth sans access_token');
    const lifetime = num(j.expires_in) ?? 7200;
    this.token = { value, expiresAt: this.now() + lifetime * 1000 };
    return value;
  }

  /** Appel authentifié ; un token refusé (401) est renouvelé une fois. */
  private async call(
    path: string,
    opts: { method?: 'GET' | 'PUT'; query?: Record<string, string | number>; json?: Json } = {},
  ): Promise<Json> {
    const method = opts.method ?? 'GET';
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      const query = new URLSearchParams(
        Object.entries({ ...opts.query, timestamp: this.now() }).map(([k, v]) => [k, String(v)]),
      );
      const url = method === 'GET' ? `${API_URL}${path}?${query}` : `${API_URL}${path}`;
      const res = await this.send(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(opts.json ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.json ? JSON.stringify({ ...opts.json, timestamp: this.now() }) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      // Erreur passagère du cloud (502/503/504) : une seconde tentative après 2 s.
      if (res.status >= 502 && res.status <= 504 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (res.status !== 200) {
        const detail = describe(res.body);
        throw new QingpingError(
          `Qingping a répondu HTTP ${res.status} sur ${path}${detail ? `: ${detail}` : ''}`,
          res.status,
        );
      }
      // Les écritures (PUT) peuvent répondre 200 avec un corps vide.
      if (method !== 'GET' && !res.body.trim()) return {};
      const body = parseJson(res.body);
      if (!body || typeof body !== 'object') throw new QingpingError(`Réponse non JSON sur ${path}`);
      const j = body as Json;
      // L'API peut répondre 200 avec un message d'erreur à la place des données.
      if (str(j.msg) && !('devices' in j) && !('data' in j) && !('events' in j)) {
        throw new QingpingError(`Qingping a refusé ${path}: ${describe(res.body)}`);
      }
      return j;
    }
    throw new QingpingError('Accès refusé (HTTP 401)', 401);
  }

  async listDevices(): Promise<Device[]> {
    const devices: Device[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.call('/devices', { query: { offset, limit: PAGE_SIZE } });
      const list = Array.isArray(body.devices) ? body.devices : [];
      devices.push(...list.map(parseDevice).filter((d): d is Device => d !== null));
      offset += list.length;
      const total = num(body.total);
      if (list.length === 0 || total === null || offset >= total) break;
    }
    return devices;
  }

  /** Historique des mesures entre deux instants (secondes Unix). */
  async history(mac: string, startS: number, endS: number): Promise<Sample[]> {
    const samples: Sample[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.call('/devices/data', {
        query: { mac: normalizeMac(mac), start_time: startS, end_time: endS, offset, limit: HISTORY_PAGE_SIZE },
      });
      const list = Array.isArray(body.data) ? body.data : [];
      for (const raw of list) {
        const { readings, ts } = parseReadings(raw);
        if (ts) samples.push({ ts, at: iso(ts)!, readings });
      }
      offset += list.length;
      const total = num(body.total);
      if (list.length === 0 || total === null || offset >= total) break;
    }
    return samples.sort((a, b) => a.ts - b.ts);
  }

  /** Alertes (seuils configurés dans l'app) déclenchées entre deux instants. */
  async events(mac: string, startS: number, endS: number): Promise<AlertEvent[]> {
    const out: AlertEvent[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.call('/devices/events', {
        query: { mac: normalizeMac(mac), start_time: startS, end_time: endS, offset, limit: HISTORY_PAGE_SIZE },
      });
      const list = Array.isArray(body.events) ? body.events : [];
      for (const raw of list) {
        const e = obj(raw);
        const alert = obj(e.alert_config);
        const { readings, ts } = parseReadings(e.data);
        out.push({
          at: iso(ts),
          metric: str(alert.metric_name),
          operator: str(alert.operator),
          threshold: num(alert.threshold),
          status: num(e.status),
          readings,
        });
      }
      offset += list.length;
      const total = num(body.total);
      if (list.length === 0 || total === null || offset >= total) break;
    }
    return out;
  }

  async updateSettings(macs: string[], reportIntervalS: number, collectIntervalS: number): Promise<void> {
    await this.call('/devices/settings', {
      method: 'PUT',
      json: { mac: macs.map(normalizeMac), report_interval: reportIntervalS, collect_interval: collectIntervalS },
    });
  }
}
