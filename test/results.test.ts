import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Aggregator, buildInsights, buildVerdict, latencyStats, percentile } from '../src/results';
import { DEFAULTS, validateConfig } from '../src/validate';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');

function pt(metric: string, ms: number, value: number, tags: Record<string, string> = {}): string {
  return JSON.stringify({ metric, type: 'Point', data: { time: new Date(ms).toISOString(), value, tags } });
}
/** One request as k6 emits it. */
function request(lines: string[], ms: number, status: string, durationMs: number, errorCode?: string): void {
  const tags: Record<string, string> = { status };
  if (errorCode) {
    tags.error_code = errorCode;
  }
  lines.push(pt('http_reqs', ms, 1, tags));
  lines.push(pt('http_req_duration', ms, durationMs, tags));
  lines.push(pt('http_req_failed', ms, Number(status) >= 400 || status === '0' ? 1 : 0, tags));
}

function config(overrides: Record<string, unknown> = {}) {
  const r = validateConfig({ ...DEFAULTS, rate: 5, durationSec: 10, ...overrides });
  if (!r.ok) {
    throw new Error(r.errors.join(','));
  }
  return r;
}

describe('percentile', () => {
  it('interpolates like k6', () => {
    const s = [1, 2, 3, 4, 5];
    assert.equal(percentile(s, 50), 3);
    assert.equal(percentile(s, 0), 1);
    assert.equal(percentile(s, 100), 5);
    assert.ok(Math.abs(percentile(s, 95) - 4.8) < 1e-9);
    assert.equal(percentile([7], 95), 7);
    assert.ok(Number.isNaN(percentile([], 50)));
  });
  it('latencyStats returns null for no data', () => {
    assert.equal(latencyStats([]), null);
    const l = latencyStats([10, 20, 30, 40, 50]);
    assert.ok(l);
    assert.equal(l.min, 10);
    assert.equal(l.max, 50);
    assert.equal(l.avg, 30);
    assert.equal(l.p50, 30);
  });
});

describe('Aggregator', () => {
  it('summarises a clean completed run', () => {
    const c = config();
    const lines: string[] = ['{"type":"Metric","data":{"name":"http_reqs"},"metric":"http_reqs"}', 'garbage'];
    for (let i = 0; i < 50; i++) {
      request(lines, T0 + i * 200, '200', 100 + (i % 5) * 10);
    }
    const agg = new Aggregator(c.config.durationSec);
    lines.forEach((l) => agg.addLine(l));
    const { summary, series, verdict } = agg.finish({ ...c, status: 'completed', wallSec: 12 });

    assert.equal(summary.totalRequests, 50);
    assert.equal(summary.failedRequests, 0);
    assert.equal(summary.errorRatePct, 0);
    assert.equal(summary.achievedRps, 5);
    assert.deepEqual(summary.statusCodes, { '200': 50 });
    assert.ok(summary.latency);
    assert.equal(summary.latency.min, 100);
    assert.equal(summary.latency.max, 140);
    assert.ok(series.length >= 9 && series.length <= 10);
    assert.ok(series.slice(0, -1).every((p) => Math.abs(p.rps - 5) < 0.01));
    assert.equal(verdict.overall, 'pass');
    assert.equal(verdict.generatorKeptUp, true);
  });

  it('counts failures, timeouts and connection errors; ignores connection errors in latency', () => {
    const c = config({ timeoutSec: 2 });
    const lines: string[] = [];
    request(lines, T0, '200', 50);
    request(lines, T0 + 100, '503', 80);
    request(lines, T0 + 200, '503', 90);
    request(lines, T0 + 300, '0', 2000, '1050'); // timeout: duration ~ timeout, counts toward latency
    request(lines, T0 + 400, '0', 0, '1212'); // connection refused: ~0 ms, must not drag latency down
    const agg = new Aggregator(10);
    lines.forEach((l) => agg.addLine(l));
    const { summary } = agg.finish({ ...c, status: 'stopped', wallSec: 1 });

    assert.equal(summary.totalRequests, 5);
    assert.equal(summary.failedRequests, 4);
    assert.equal(summary.timeouts, 1);
    assert.equal(summary.networkErrors, 1);
    assert.equal(summary.statusCodes['503'], 2);
    assert.equal(summary.statusCodes['0'], 2);
    assert.equal(summary.latency?.samples, 4);
    assert.equal(summary.latency?.max, 2000);
    assert.equal(summary.latency?.min, 50);
  });

  it('records dropped iterations and flags that the generator fell behind', () => {
    const c = config();
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      request(lines, T0 + i * 500, '200', 100);
    }
    lines.push(pt('dropped_iterations', T0 + 100, 1));
    lines.push(pt('dropped_iterations', T0 + 600, 3));
    const agg = new Aggregator(10);
    lines.forEach((l) => agg.addLine(l));
    const { summary, verdict } = agg.finish({ ...c, status: 'completed', wallSec: 12 });
    assert.equal(summary.droppedRequests, 4);
    assert.equal(summary.achievedRps, 2);
    assert.equal(verdict.generatorKeptUp, false);
    assert.equal(verdict.overall, 'incomplete');
  });

  it('tolerates a truncated final line (hard stop)', () => {
    const c = config();
    const lines: string[] = [];
    request(lines, T0, '200', 10);
    const agg = new Aggregator(10);
    lines.forEach((l) => agg.addLine(l));
    agg.addLine('{"metric":"http_reqs","type":"Point","data":{"time":"2026-11-01T10:00:01.');
    const { summary } = agg.finish({ ...c, status: 'stopped', wallSec: 2 });
    assert.equal(summary.totalRequests, 1);
  });

  it('handles a run with no data', () => {
    const c = config();
    const agg = new Aggregator(10);
    const { summary, series, verdict } = agg.finish({ ...c, status: 'completed', wallSec: 1 });
    assert.equal(summary.totalRequests, 0);
    assert.equal(summary.latency, null);
    assert.deepEqual(series, []);
    assert.equal(verdict.overall, 'incomplete');
  });

  it('widens buckets for long runs so charts stay small', () => {
    assert.equal(new Aggregator(60).bucketSec, 1);
    assert.equal(new Aggregator(300).bucketSec, 1);
    assert.equal(new Aggregator(3600).bucketSec, 12);
  });
});

describe('buildVerdict', () => {
  const c = config({ p95TargetMs: 500, errorRateTargetPct: 1 });
  function summaryWith(p95: number, errPct: number) {
    const agg = new Aggregator(10);
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      request(lines, T0 + i * 100, i < errPct ? '500' : '200', p95);
    }
    lines.forEach((l) => agg.addLine(l));
    return agg.finish({ ...c, status: 'completed', wallSec: 10 }).summary;
  }
  it('passes when both targets are met (boundary counts as met)', () => {
    const s = summaryWith(500, 1);
    s.achievedRps = s.targetRps;
    assert.equal(buildVerdict(s, c.config, 'completed').overall, 'pass');
  });
  it('fails on slow responses', () => {
    const s = summaryWith(900, 0);
    s.achievedRps = s.targetRps;
    const v = buildVerdict(s, c.config, 'completed');
    assert.equal(v.p95.passed, false);
    assert.equal(v.overall, 'fail');
  });
  it('fails on errors', () => {
    const s = summaryWith(100, 3);
    s.achievedRps = s.targetRps;
    const v = buildVerdict(s, c.config, 'completed');
    assert.equal(v.errorRate.passed, false);
    assert.equal(v.overall, 'fail');
  });
  it('a stopped run that met its targets is incomplete, not a pass', () => {
    const s = summaryWith(100, 0);
    assert.equal(buildVerdict(s, c.config, 'stopped').overall, 'incomplete');
  });
});

describe('buildInsights', () => {
  it('explains problems in plain language without claiming a cause', () => {
    const c = config({ p95TargetMs: 200, timeoutSec: 3 });
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      request(lines, T0 + i * 100, i % 10 === 0 ? '429' : '200', 100 + i * 15);
    }
    lines.push(pt('dropped_iterations', T0 + 50, 5));
    const agg = new Aggregator(10);
    lines.forEach((l) => agg.addLine(l));
    const { summary, series, verdict } = agg.finish({ ...c, status: 'completed', wallSec: 10 });
    const insights = buildInsights({ summary, verdict, config: c.config, series, status: 'completed', isLoopback: true });
    const text = insights.map((i) => i.text).join('\n');
    assert.match(text, /rate-limiting/);
    assert.match(text, /ran out of virtual users/);
    assert.match(text, /same computer/);
    assert.match(text, /grew as the test went on/);
    assert.equal(insights.some((i) => i.level === 'bad'), true);
    assert.doesNotMatch(text, /database/i);
  });

  it('says so when nothing completed', () => {
    const c = config();
    const agg = new Aggregator(10);
    const { summary, series, verdict } = agg.finish({ ...c, status: 'completed', wallSec: 1 });
    const insights = buildInsights({ summary, verdict, config: c.config, series, status: 'completed', isLoopback: false });
    assert.equal(insights.length, 1);
    assert.match(insights[0].text, /No requests completed/);
  });
});
