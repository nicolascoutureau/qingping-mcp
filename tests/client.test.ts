import { describe, expect, it } from 'vitest';
import { QingpingClient, type RequestFn } from '../src/client.js';
import { summarize, assess, downsample, freshness, coverage } from '../src/analysis.js';

const NOW = 1_762_545_600_000; // ms

function fakeCloud(overrides: Partial<Record<string, (url: URL) => { status: number; body: unknown }>> = {}) {
  const calls: { method: string; url: URL; headers: Record<string, string>; body?: string }[] = [];
  const request: RequestFn = async (raw, init) => {
    const url = new URL(raw);
    calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    const route = `${init.method} ${url.pathname}`;
    const handler = overrides[route];
    if (handler) {
      const r = handler(url);
      return { status: r.status, body: JSON.stringify(r.body) };
    }
    if (route === 'POST /oauth2/token') {
      return { status: 200, body: JSON.stringify({ access_token: 'tok-1', expires_in: 7199 }) };
    }
    if (route === 'GET /v1/apis/devices') {
      return {
        status: 200,
        body: JSON.stringify({
          total: 1,
          devices: [
            {
              info: {
                mac: '58:2D:34:00:00:01',
                name: 'Chambre',
                product: { id: 1101, en_name: 'Qingping Air Monitor' },
                status: { offline: false },
                setting: { report_interval: 900, collect_interval: 60 },
              },
              data: {
                timestamp: { value: 1762545000 },
                co2: { value: 1068 },
                pm25: { value: 12 },
                humidity: { value: 60.9 },
                temperature: { value: 19.7 },
                tvoc: { value: 2.471, status: 2 },
                battery: { value: 100, status: 2 },
              },
            },
          ],
        }),
      };
    }
    if (route === 'GET /v1/apis/devices/data') {
      const offset = Number(url.searchParams.get('offset'));
      const all = Array.from({ length: 250 }, (_, i) => ({
        timestamp: { value: 1762500000 + i * 60 },
        co2: { value: i < 100 ? 900 : 1200 },
      }));
      return { status: 200, body: JSON.stringify({ total: 250, data: all.slice(offset, offset + 200) }) };
    }
    return { status: 404, body: '{}' };
  };
  return { request, calls };
}

describe('QingpingClient', () => {
  it('gets a token then lists devices', async () => {
    const { request, calls } = fakeCloud();
    const c = new QingpingClient('key', 'secret', request, () => NOW);
    const [d] = await c.listDevices();
    expect(d.mac).toBe('582D34000001');
    expect(d.name).toBe('Chambre');
    expect(d.readings.co2).toBe(1068);
    expect(d.unhealthy).toEqual(['tvoc (warming up)']);
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from('key:secret').toString('base64')}`);
    expect(calls[1].headers.authorization).toBe('Bearer tok-1');
    expect(calls[1].url.searchParams.get('timestamp')).toBe(String(NOW));
  });

  it('reuses the token and renews it after a 401', async () => {
    let first = true;
    const { request, calls } = fakeCloud({
      'GET /v1/apis/devices': () => {
        if (first) {
          first = false;
          return { status: 401, body: {} };
        }
        return { status: 200, body: { total: 0, devices: [] } };
      },
    });
    const c = new QingpingClient('key', 'secret', request, () => NOW);
    await c.listDevices();
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      'POST /oauth2/token',
      'GET /v1/apis/devices',
      'POST /oauth2/token',
      'GET /v1/apis/devices',
    ]);
  });

  it('paginates the history', async () => {
    const { request } = fakeCloud();
    const c = new QingpingClient('key', 'secret', request, () => NOW);
    const s = await c.history('582D34000001', 1762500000, 1762600000);
    expect(s).toHaveLength(250);
    const sum = summarize(s, ['co2']);
    expect(sum.sampleIntervalMin).toBe(1);
    expect(sum.metrics.co2?.minutesAbove).toEqual({ '>1000': 150, '>1500': 0 });
    expect(downsample(s, 50)).toHaveLength(50);
  });

  it('does not leak the secret in the auth error', async () => {
    const { request } = fakeCloud({
      'POST /oauth2/token': () => ({ status: 401, body: { error: 'invalid_client' } }),
    });
    const c = new QingpingClient('key', 'super-secret-value', request, () => NOW);
    await expect(c.listDevices()).rejects.toThrow(/refused \(HTTP 401\): invalid_client/);
    await expect(c.listDevices()).rejects.not.toThrow(/super-secret/);
  });
});

describe('assess', () => {
  it('rates the readings', () => {
    expect(assess({ co2: 1068, pm25: 12, humidity: 60.9 })).toEqual({
      co2: 'high — ventilate',
      pm25: 'good',
      humidity: 'humid',
    });
  });
});

describe('listDevices pagination', () => {
  it('keeps each device once when total is larger than what the API returns', async () => {
    const page = {
      total: 2,
      devices: [{ info: { mac: '582D34000001', name: 'Bedroom' }, data: { co2: { value: 900 } } }],
    };
    const { request, calls } = fakeCloud({ 'GET /v1/apis/devices': () => ({ status: 200, body: page }) });
    const c = new QingpingClient('key', 'secret', request, () => NOW);
    const devices = await c.listDevices();
    expect(devices.map((d) => d.mac)).toEqual(['582D34000001']);
    expect(calls.filter((x) => x.url.pathname === '/v1/apis/devices')).toHaveLength(2);
  });
});

describe('freshness', () => {
  it('is stale with no reading', () => {
    expect(freshness(null, 300, 10_000)).toEqual({ ageMin: null, stale: true });
  });
  it('is fresh within 2 report intervals + 2 min', () => {
    expect(freshness(10_000 - 700, 300, 10_000)).toEqual({ ageMin: 12, stale: false });
  });
  it('is stale beyond 2 report intervals + 2 min', () => {
    expect(freshness(10_000 - 800, 300, 10_000)).toEqual({ ageMin: 13, stale: true });
  });
  it('falls back to a 15 min interval when unknown', () => {
    expect(freshness(10_000 - 1_900, null, 10_000).stale).toBe(false);
    expect(freshness(10_000 - 2_000, null, 10_000).stale).toBe(true);
  });
});

describe('coverage', () => {
  const sample = (ts: number) => ({ ts, at: String(ts), readings: { co2: 800 } });

  it('is zero for an empty window', () => {
    const c = coverage([], 0, 3_600, 60);
    expect(c).toMatchObject({ windowMin: 60, coveredMin: 0, percent: 0, largestGapMin: 60 });
    expect(c.largestGap).not.toBeNull();
  });

  it('is full for regular samples', () => {
    const samples = Array.from({ length: 60 }, (_, i) => sample(i * 60));
    const c = coverage(samples, 0, 3_600, 60);
    expect(c.percent).toBe(100);
    expect(c.largestGap).toBeNull();
  });

  it('reports the largest gap', () => {
    // Samples during the first 10 minutes only, then nothing for 50 minutes.
    const samples = Array.from({ length: 10 }, (_, i) => sample(i * 60));
    const c = coverage(samples, 0, 3_600, 60);
    expect(c.coveredMin).toBe(11);
    expect(c.percent).toBe(18);
    expect(c.largestGapMin).toBe(51);
    expect(c.largestGap).not.toBeNull();
  });

  it('ignores samples outside the window', () => {
    expect(coverage([sample(-100), sample(5_000)], 0, 3_600, 60).coveredMin).toBe(0);
  });
});
