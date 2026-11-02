import { HttpMethod, TestConfig, TestPlan, TrafficMode } from './types';

export const LIMITS = {
  maxRps: 500,
  minRps: 0.1,
  minDurationSec: 5,
  maxDurationSec: 3600,
  maxTotalRequests: 100_000,
  maxTimeoutSec: 60,
  maxVUs: 500,
  maxUrlLength: 2048,
  maxLabelLength: 60,
} as const;

export const DEFAULTS: TestConfig = {
  label: '',
  url: 'http://localhost:3000/',
  method: 'GET',
  mode: 'rate',
  rate: 10,
  totalRequests: 600,
  durationSec: 60,
  p95TargetMs: 500,
  errorRateTargetPct: 1,
  timeoutSec: 10,
  confirmedPermission: false,
};

export type ValidationResult =
  | { ok: true; config: TestConfig; plan: TestPlan }
  | { ok: false; errors: string[] };

/** True for addresses that point back at the person's own computer. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return true;
  }
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function num(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value);
  }
  return NaN;
}

/**
 * Convert a (possibly fractional) requests-per-second value into the integer rate + time unit
 * that k6's constant-arrival-rate executor needs, e.g. 0.5/s -> 5 per 10s.
 */
export function toK6Rate(rps: number): { rate: number; timeUnit: string } {
  for (const scale of [1, 10, 100]) {
    const scaled = rps * scale;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) {
      return { rate: Math.max(1, Math.round(scaled)), timeUnit: `${scale}s` };
    }
  }
  return { rate: Math.max(1, Math.round(rps * 100)), timeUnit: '100s' };
}

export function buildPlan(config: TestConfig): TestPlan {
  let targetRps: number;
  let k6Rate: number;
  let k6TimeUnit: string;
  if (config.mode === 'total') {
    const total = config.totalRequests ?? 0;
    targetRps = total / config.durationSec;
    k6Rate = total;
    k6TimeUnit = `${config.durationSec}s`;
  } else {
    targetRps = config.rate ?? 0;
    const k = toK6Rate(targetRps);
    k6Rate = k.rate;
    k6TimeUnit = k.timeUnit;
  }
  const plannedRequests = Math.max(1, Math.round(targetRps * config.durationSec));
  const preAllocatedVUs = clamp(Math.ceil(targetRps), 1, 100);
  const maxVUs = clamp(
    Math.ceil(targetRps * Math.min(config.timeoutSec, 10)),
    preAllocatedVUs,
    LIMITS.maxVUs,
  );
  return { targetRps, plannedRequests, k6Rate, k6TimeUnit, preAllocatedVUs, maxVUs };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Validate untrusted input (it arrives from a webview) and produce a sanitised config + plan. */
export function validateConfig(input: unknown): ValidationResult {
  const errors: string[] = [];
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  // --- URL ---
  let url = '';
  let hostname = '';
  const rawUrl = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!rawUrl) {
    errors.push('Enter the URL to test.');
  } else if (rawUrl.length > LIMITS.maxUrlLength) {
    errors.push('That URL is too long.');
  } else {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.push('Only http:// and https:// URLs can be tested.');
      } else if (u.username || u.password) {
        errors.push('Remove the username/password from the URL (results are saved to disk).');
      } else if (!u.hostname) {
        errors.push('The URL needs a host name, for example http://localhost:3000/.');
      } else {
        u.hash = '';
        url = u.href;
        hostname = u.hostname;
      }
    } catch {
      errors.push('That does not look like a valid URL. Include http:// or https://.');
    }
  }

  // --- Method ---
  const method = raw.method === 'HEAD' ? 'HEAD' : raw.method === 'GET' || raw.method === undefined ? 'GET' : null;
  if (method === null) {
    errors.push('Only GET and HEAD requests are supported in this version.');
  }

  // --- Traffic ---
  const mode: TrafficMode = raw.mode === 'total' ? 'total' : 'rate';
  const durationSec = num(raw.durationSec);
  if (!Number.isInteger(durationSec) || durationSec < LIMITS.minDurationSec || durationSec > LIMITS.maxDurationSec) {
    errors.push(`Duration must be a whole number of seconds between ${LIMITS.minDurationSec} and ${LIMITS.maxDurationSec}.`);
  }

  let rate: number | undefined;
  let totalRequests: number | undefined;
  if (mode === 'rate') {
    rate = num(raw.rate);
    if (!Number.isFinite(rate) || rate < LIMITS.minRps || rate > LIMITS.maxRps) {
      errors.push(`Requests per second must be between ${LIMITS.minRps} and ${LIMITS.maxRps}.`);
    } else if (Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-9) {
      errors.push('Requests per second can have at most 2 decimal places.');
    }
  } else {
    totalRequests = num(raw.totalRequests);
    if (!Number.isInteger(totalRequests) || totalRequests < 1 || totalRequests > LIMITS.maxTotalRequests) {
      errors.push(`Total requests must be a whole number between 1 and ${LIMITS.maxTotalRequests.toLocaleString('en-US')}.`);
    } else if (Number.isInteger(durationSec) && durationSec > 0) {
      const rps = totalRequests / durationSec;
      if (rps > LIMITS.maxRps) {
        errors.push(`That is ${rps.toFixed(1)} requests/second; the limit is ${LIMITS.maxRps}. Use a longer duration or fewer requests.`);
      } else if (rps < LIMITS.minRps) {
        errors.push(`That is under ${LIMITS.minRps} requests/second. Use more requests or a shorter duration.`);
      }
    }
  }
  if (mode === 'rate' && Number.isFinite(rate) && Number.isInteger(durationSec)) {
    const planned = (rate as number) * durationSec;
    if (planned > LIMITS.maxTotalRequests) {
      errors.push(
        `That would send about ${Math.round(planned).toLocaleString('en-US')} requests; the limit is ${LIMITS.maxTotalRequests.toLocaleString('en-US')} per test. Lower the rate or duration.`,
      );
    }
  }

  // --- Targets & timeout ---
  const p95TargetMs = num(raw.p95TargetMs);
  if (!Number.isFinite(p95TargetMs) || p95TargetMs < 1 || p95TargetMs > 600_000) {
    errors.push('The p95 response-time target must be between 1 and 600000 ms.');
  }
  const errorRateTargetPct = num(raw.errorRateTargetPct);
  if (!Number.isFinite(errorRateTargetPct) || errorRateTargetPct < 0 || errorRateTargetPct > 100) {
    errors.push('The error-rate target must be between 0 and 100 %.');
  }
  const timeoutSec = num(raw.timeoutSec);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > LIMITS.maxTimeoutSec) {
    errors.push(`The request timeout must be a whole number of seconds between 1 and ${LIMITS.maxTimeoutSec}.`);
  }

  // --- Label ---
  // eslint-disable-next-line no-control-regex
  const label = (typeof raw.label === 'string' ? raw.label : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, LIMITS.maxLabelLength);

  // --- Permission (only needed for targets that are not this computer) ---
  const confirmedPermission = raw.confirmedPermission === true;
  if (hostname && !isLoopbackHost(hostname) && !confirmedPermission) {
    errors.push('Confirm that you own this site or have permission to load-test it.');
  }

  if (errors.length > 0 || method === null) {
    return { ok: false, errors };
  }

  const config: TestConfig = {
    label,
    url,
    method: method as HttpMethod,
    mode,
    ...(mode === 'rate' ? { rate } : { totalRequests }),
    durationSec,
    p95TargetMs,
    errorRateTargetPct,
    timeoutSec,
    confirmedPermission,
  };
  return { ok: true, config, plan: buildPlan(config) };
}
