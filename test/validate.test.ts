import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULTS, LIMITS, isLoopbackHost, toK6Rate, validateConfig } from '../src/validate';

const base = { ...DEFAULTS, url: 'http://localhost:3000/api/products' };

function ok(input: unknown) {
  const r = validateConfig(input);
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join(' | '));
  if (!r.ok) {
    throw new Error('unreachable');
  }
  return r;
}
function errors(input: unknown): string[] {
  const r = validateConfig(input);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.errors;
}

describe('validateConfig', () => {
  it('accepts a localhost rate test and builds the k6 plan', () => {
    const r = ok(base);
    assert.equal(r.plan.targetRps, 10);
    assert.equal(r.plan.plannedRequests, 600);
    assert.equal(r.plan.k6Rate, 10);
    assert.equal(r.plan.k6TimeUnit, '1s');
    assert.ok(r.plan.maxVUs >= r.plan.preAllocatedVUs);
  });

  it('turns "total requests over a duration" into the same average rate (6000 over 300 s = 20/s)', () => {
    const r = ok({ ...base, mode: 'total', totalRequests: 6000, durationSec: 300 });
    assert.equal(r.plan.targetRps, 20);
    assert.equal(r.plan.k6Rate, 6000);
    assert.equal(r.plan.k6TimeUnit, '300s');
    assert.equal(r.plan.plannedRequests, 6000);
  });

  it('handles fractional rates by scaling the time unit', () => {
    assert.deepEqual(toK6Rate(0.5), { rate: 5, timeUnit: '10s' });
    assert.deepEqual(toK6Rate(2.25), { rate: 225, timeUnit: '100s' });
    assert.deepEqual(toK6Rate(20), { rate: 20, timeUnit: '1s' });
  });

  it('accepts numbers sent as strings (form fields)', () => {
    const r = ok({ ...base, rate: '25', durationSec: '30', p95TargetMs: '300', errorRateTargetPct: '0.5', timeoutSec: '5' });
    assert.equal(r.config.rate, 25);
    assert.equal(r.config.durationSec, 30);
  });

  it('requires permission for anything that is not this computer', () => {
    const remote = { ...base, url: 'https://my-app.vercel.app/' };
    assert.match(errors(remote).join(' '), /permission/i);
    assert.equal(validateConfig({ ...remote, confirmedPermission: true }).ok, true);
    assert.equal(validateConfig({ ...base, url: 'http://127.0.0.1:5000/x' }).ok, true);
    assert.equal(validateConfig({ ...base, url: 'http://192.168.1.20:3000/' }).ok, false);
  });

  it('rejects bad URLs', () => {
    assert.ok(errors({ ...base, url: '' }).length);
    assert.ok(errors({ ...base, url: 'localhost:3000' }).join(' ').match(/http/i));
    assert.ok(errors({ ...base, url: 'ftp://example.com/file' }).join(' ').match(/http/i));
    assert.ok(errors({ ...base, url: 'http://user:pass@localhost:3000/' }).join(' ').match(/username/i));
    assert.ok(errors({ ...base, url: 'http://localhost/' + 'a'.repeat(3000) }).join(' ').match(/too long/i));
  });

  it('enforces limits', () => {
    assert.ok(errors({ ...base, rate: LIMITS.maxRps + 1 }).length);
    assert.ok(errors({ ...base, rate: 0 }).length);
    assert.ok(errors({ ...base, durationSec: 1 }).length);
    assert.ok(errors({ ...base, durationSec: LIMITS.maxDurationSec + 1 }).length);
    assert.ok(errors({ ...base, durationSec: 10.5 }).length);
    assert.ok(errors({ ...base, rate: 500, durationSec: 600 }).join(' ').match(/limit/i));
    assert.ok(errors({ ...base, mode: 'total', totalRequests: 100_001, durationSec: 3600 }).length);
    assert.ok(errors({ ...base, mode: 'total', totalRequests: 6000, durationSec: 5 }).join(' ').match(/requests\/second/));
    assert.ok(errors({ ...base, p95TargetMs: 0 }).length);
    assert.ok(errors({ ...base, errorRateTargetPct: 101 }).length);
    assert.ok(errors({ ...base, timeoutSec: 0 }).length);
    assert.ok(errors({ ...base, rate: 'abc' }).length);
  });

  it('reports several problems at once', () => {
    const e = errors({ ...base, url: '', rate: -1, durationSec: 0 });
    assert.ok(e.length >= 3);
  });

  it('cleans up the label and ignores unknown fields', () => {
    const r = ok({ ...base, label: '  Before\u0000 caching  ', evil: 'x' });
    assert.equal(r.config.label, 'Before  caching');
    assert.equal('evil' in r.config, false);
  });

  it('only allows GET and HEAD', () => {
    assert.ok(errors({ ...base, method: 'POST' }).length);
    assert.equal(ok({ ...base, method: 'HEAD' }).config.method, 'HEAD');
  });

  it('survives non-object input', () => {
    assert.equal(validateConfig(null).ok, false);
    assert.equal(validateConfig('hello').ok, false);
    assert.equal(validateConfig(undefined).ok, false);
  });
});

describe('isLoopbackHost', () => {
  it('recognises local addresses only', () => {
    for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      assert.equal(isLoopbackHost(h), true, h);
    }
    for (const h of ['example.com', '10.0.0.1', '192.168.0.2', '0.0.0.0', 'localhost.evil.com', '127.0.0.1.evil.com']) {
      assert.equal(isLoopbackHost(h), false, h);
    }
  });
});
