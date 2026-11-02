import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildK6Args, buildK6Env, checkK6, makeResultId, startTest } from '../src/k6';
import { ResultStore, isValidResultId, toListItem } from '../src/storage';
import { DEFAULTS, validateConfig } from '../src/validate';
import { K6Status, TestResult } from '../src/types';

const SCRIPT = path.resolve(__dirname, '..', '..', 'k6', 'requestpulse.js');

function plan(overrides: Record<string, unknown>) {
  const r = validateConfig({ ...DEFAULTS, ...overrides });
  if (!r.ok) {
    throw new Error(r.errors.join(','));
  }
  return r;
}

describe('k6 invocation', () => {
  it('passes everything as separate arguments and environment values, never a shell string', () => {
    const evil = 'http://localhost:3000/a?b=1&c=$(rm -rf ~);`id`';
    const p = plan({ url: evil });
    const env = buildK6Env(p.config, p.plan, {});
    assert.equal(env.RP_URL, new URL(evil).href);
    const args = buildK6Args('/x/script.js', '/tmp/out.ndjson');
    assert.equal(args[0], 'run');
    assert.ok(args.every((a) => typeof a === 'string'));
    assert.ok(!args.some((a) => a.includes('localhost')), 'the URL must not appear in the command-line arguments');
    assert.equal(args.at(-1), '/x/script.js');
    assert.equal(env.RP_RATE, '10');
    assert.equal(env.RP_TIME_UNIT, '1s');
    assert.equal(env.RP_DURATION_SEC, '60');
    assert.equal(env.RP_METHOD, 'GET');
  });

  it('the k6 script reads settings from __ENV only', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(src, /__ENV\.RP_URL/);
    assert.match(src, /constant-arrival-rate/);
    assert.match(src, /redirects: 0/);
  });
});

describe('result ids & storage', () => {
  it('makes sortable, valid ids', () => {
    const id = makeResultId(new Date('2026-11-01T16:30:12.345Z'));
    assert.match(id, /^20261101-163012-[0-9a-f]{4}$/);
    assert.equal(isValidResultId(id), true);
  });
  it('rejects ids that could escape the folder', () => {
    for (const bad of ['../../etc/passwd', '20261101-163012-zzzz', '', '20261101-163012-abcd.json', '/abs', undefined, 42]) {
      assert.equal(isValidResultId(bad), false, String(bad));
    }
  });
  it('saves, lists, reads and deletes results', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-'));
    try {
      const store = new ResultStore(dir);
      assert.deepEqual(await store.list(), []);
      const mk = (id: string, createdAt: string): TestResult => {
        const p = plan({});
        return {
          schemaVersion: 1, id, label: 'x', createdAt, startedAt: createdAt, endedAt: createdAt, status: 'completed',
          config: p.config, plan: p.plan, k6Version: '1.0.0',
          summary: { totalRequests: 1, failedRequests: 0, errorRatePct: 0, droppedRequests: 0, plannedRequests: 1, achievedRps: 1, targetRps: 1, measuredSec: 1, latency: null, statusCodes: {}, timeouts: 0, networkErrors: 0 },
          verdict: { p95: { target: 1, actual: null, passed: false }, errorRate: { target: 1, actual: 0, passed: true }, generatorKeptUp: true, overall: 'incomplete' },
          bucketSec: 1, series: [], insights: [],
        };
      };
      await store.save(mk('20261101-100000-aaaa', '2026-11-01T10:00:00.000Z'));
      await store.save(mk('20261101-110000-bbbb', '2026-11-01T11:00:00.000Z'));
      fs.writeFileSync(path.join(dir, '20261101-120000-cccc.json'), '{ not json');
      const list = await store.list();
      assert.deepEqual(list.map((i) => i.id), ['20261101-110000-bbbb', '20261101-100000-aaaa']);
      assert.equal(toListItem((await store.get('20261101-100000-aaaa'))!).p95, null);
      assert.equal(await store.get('20261101-120000-cccc'), null);
      await store.delete('20261101-100000-aaaa');
      assert.equal((await store.list()).length, 1);
      await assert.rejects(() => store.get('../x' as string).then(() => { throw new Error('should not resolve'); }), /should not resolve/).catch(() => undefined);
      assert.equal(await store.get('../x'), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// End-to-end tests against a real k6 binary. They are skipped automatically when k6 is not installed.

describe('end to end with k6', async () => {
  const k6: K6Status = await checkK6(process.env.REQUESTPULSE_K6 || 'k6');
  const skip = k6.ok ? false : 'k6 is not installed';
  let server: http.Server;
  let base = '';
  let tmp = '';
  let hits = 0;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
    server = http.createServer((req, res) => {
      hits++;
      if (req.url?.startsWith('/flaky')) {
        res.statusCode = hits % 5 === 0 ? 503 : 200;
        res.end('x');
      } else if (req.url?.startsWith('/slow')) {
        setTimeout(() => res.end('slow'), 150);
      } else {
        res.end('{"ok":true}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server?.close();
    server?.closeAllConnections?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const opts = () => ({ k6Path: process.env.REQUESTPULSE_K6 || 'k6', k6Version: k6.version, scriptPath: SCRIPT, workDir: tmp });

  it('delivers the requested rate and reports it accurately', { skip, timeout: 60_000 }, async () => {
    const p = plan({ url: `${base}/slow`, rate: 20, durationSec: 6, p95TargetMs: 1000 });
    const phases: string[] = [];
    const run = startTest(p.config, p.plan, { ...opts(), onPhase: (ph) => phases.push(ph) });
    const r = await run.result;
    assert.equal(r.status, 'completed');
    assert.ok(Math.abs(r.summary.totalRequests - 120) <= 6, `got ${r.summary.totalRequests}`);
    assert.ok(Math.abs(r.summary.achievedRps - 20) < 1.5, `got ${r.summary.achievedRps}`);
    assert.equal(r.summary.failedRequests, 0);
    assert.ok(r.summary.latency && r.summary.latency.p50 >= 140 && r.summary.latency.p50 < 400, JSON.stringify(r.summary.latency));
    assert.equal(r.verdict.overall, 'pass');
    assert.ok(r.series.length >= 5);
    assert.ok(phases.includes('starting') && phases.includes('processing'));
    assert.ok(r.insights.length > 0);
    // raw k6 output is cleaned up
    assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.endsWith('.ndjson')), []);
  });

  it('counts server errors and fails the error-rate target', { skip, timeout: 60_000 }, async () => {
    const p = plan({ url: `${base}/flaky`, rate: 20, durationSec: 5, errorRateTargetPct: 1 });
    const r = await startTest(p.config, p.plan, opts()).result;
    assert.ok(r.summary.failedRequests > 10, `failed=${r.summary.failedRequests}`);
    assert.ok(r.summary.statusCodes['503'] > 10);
    assert.equal(r.verdict.errorRate.passed, false);
    assert.equal(r.verdict.overall, 'fail');
  });

  it('reports a dead server as failures, not as fast responses', { skip, timeout: 60_000 }, async () => {
    const p = plan({ url: 'http://127.0.0.1:1/', rate: 10, durationSec: 5 });
    const r = await startTest(p.config, p.plan, opts()).result;
    assert.equal(r.summary.failedRequests, r.summary.totalRequests);
    assert.ok(r.summary.totalRequests > 20);
    assert.equal(r.summary.latency, null);
    assert.equal(r.verdict.overall, 'fail');
    assert.match(r.insights.map((i) => i.text).join(' '), /never connected/);
  });

  it('stops on request and keeps the partial results', { skip, timeout: 60_000 }, async () => {
    const p = plan({ url: `${base}/ok`, rate: 20, durationSec: 60 });
    const phases: string[] = [];
    const run = startTest(p.config, p.plan, { ...opts(), onPhase: (ph) => phases.push(ph) });
    setTimeout(() => run.stop(), 3500);
    const started = Date.now();
    const r = await run.result;
    assert.ok(Date.now() - started < 20_000, 'stop should return promptly');
    assert.equal(r.status, 'stopped');
    assert.ok(r.summary.totalRequests > 10 && r.summary.totalRequests < 200, `got ${r.summary.totalRequests}`);
    assert.ok(phases.includes('stopping'));
    assert.equal(r.verdict.overall, 'incomplete');
  });

  it('gives a friendly error when k6 is missing', { timeout: 20_000 }, async () => {
    const p = plan({});
    await assert.rejects(
      startTest(p.config, p.plan, { ...opts(), k6Path: path.join(tmp, 'definitely-not-k6') }).result,
      /k6 was not found/,
    );
    const status = await checkK6(path.join(tmp, 'definitely-not-k6'));
    assert.equal(status.ok, false);
    assert.match(status.error ?? '', /not found/);
  });
});
