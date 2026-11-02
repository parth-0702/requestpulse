import {
  Insight,
  LatencyStats,
  ResultSummary,
  RunStatus,
  SeriesPoint,
  TestConfig,
  TestPlan,
  Verdict,
} from './types';

/** k6 reports request timeouts with this error code (status is 0 for them). */
export const K6_TIMEOUT_ERROR_CODE = '1050';

const WANTED_METRIC = /"metric":"(http_reqs|http_req_duration|http_req_failed|dropped_iterations)"/;
const MAX_SERIES_POINTS = 300;

/** Linear-interpolated percentile (same method k6 uses) over an ascending-sorted array. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) {
    return NaN;
  }
  if (n === 1) {
    return sorted[0];
  }
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) {
    return sorted[lo];
  }
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function sortedCopy(values: number[]): Float64Array {
  const arr = Float64Array.from(values);
  arr.sort();
  return arr;
}

export function latencyStats(values: number[]): LatencyStats | null {
  if (values.length === 0) {
    return null;
  }
  const s = sortedCopy(values);
  let sum = 0;
  for (const v of s) {
    sum += v;
  }
  return {
    min: round(s[0]),
    avg: round(sum / s.length),
    p50: round(percentile(s, 50)),
    p90: round(percentile(s, 90)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    max: round(s[s.length - 1]),
    samples: s.length,
  };
}

interface Bucket {
  count: number;
  failed: number;
  durations: number[];
}

/**
 * Streams k6's `--out json` lines and accumulates everything the dashboard needs.
 * Feed it one line at a time with addLine(), then call finish().
 */
export class Aggregator {
  readonly bucketSec: number;
  private firstMs = Number.POSITIVE_INFINITY;
  private lastMs = Number.NEGATIVE_INFINITY;
  private total = 0;
  private failed = 0;
  private dropped = 0;
  private timeouts = 0;
  private networkErrors = 0;
  private statusCodes: Record<string, number> = {};
  private latencies: number[] = [];
  private buckets: Bucket[] = [];
  /** Start of the first bucket; set from the first data point we see. */
  private t0: number | null = null;

  constructor(durationSec: number) {
    this.bucketSec = Math.max(1, Math.ceil(durationSec / MAX_SERIES_POINTS));
  }

  addLine(line: string): void {
    const m = WANTED_METRIC.exec(line);
    if (!m) {
      return;
    }
    let obj: { type?: string; data?: { time?: string; value?: number; tags?: Record<string, string> } };
    try {
      obj = JSON.parse(line);
    } catch {
      return; // a partial last line after a hard stop
    }
    if (obj.type !== 'Point' || !obj.data) {
      return;
    }
    const ms = Date.parse(obj.data.time ?? '');
    const value = Number(obj.data.value);
    if (!Number.isFinite(ms) || !Number.isFinite(value)) {
      return;
    }
    const tags = obj.data.tags ?? {};
    const metric = m[1];

    if (metric === 'dropped_iterations') {
      this.dropped += value;
      return;
    }

    if (ms < this.firstMs) {
      this.firstMs = ms;
    }
    if (ms > this.lastMs) {
      this.lastMs = ms;
    }
    if (this.t0 === null) {
      this.t0 = ms;
    }
    const bucket = this.bucketFor(ms);
    const status = tags.status ?? '0';
    const isTimeout = status === '0' && tags.error_code === K6_TIMEOUT_ERROR_CODE;

    switch (metric) {
      case 'http_reqs':
        this.total += value;
        bucket.count += value;
        this.statusCodes[status] = (this.statusCodes[status] ?? 0) + value;
        if (isTimeout) {
          this.timeouts += value;
        } else if (status === '0') {
          this.networkErrors += value;
        }
        break;
      case 'http_req_failed':
        if (value >= 1) {
          this.failed += 1;
          bucket.failed += 1;
        }
        break;
      case 'http_req_duration':
        // Requests that never reached a server (connection refused, DNS failure) report ~0 ms.
        // Including them would make a dead server look fast, so only count real responses and timeouts.
        if (status !== '0' || isTimeout) {
          this.latencies.push(value);
          bucket.durations.push(value);
        }
        break;
    }
  }

  private bucketFor(ms: number): Bucket {
    const t0 = this.t0 ?? ms;
    const idx = Math.max(0, Math.floor((ms - t0) / (this.bucketSec * 1000)));
    while (this.buckets.length <= idx) {
      this.buckets.push({ count: 0, failed: 0, durations: [] });
    }
    return this.buckets[idx];
  }

  finish(args: {
    config: TestConfig;
    plan: TestPlan;
    status: RunStatus;
    /** Wall-clock seconds the run lasted (used when too little data to measure). */
    wallSec: number;
  }): { summary: ResultSummary; series: SeriesPoint[]; verdict: Verdict } {
    const { config, plan, status } = args;
    const hasData = this.total > 0;
    const spanSec = hasData ? Math.max(0, (this.lastMs - this.firstMs) / 1000) : 0;
    // A completed run is measured against its configured duration; a stopped one against what actually ran.
    const measuredSec = status === 'completed' ? config.durationSec : Math.max(1, spanSec || args.wallSec);
    const achievedRps = hasData ? this.total / measuredSec : 0;
    const latency = latencyStats(this.latencies);

    const summary: ResultSummary = {
      totalRequests: this.total,
      failedRequests: this.failed,
      errorRatePct: this.total > 0 ? round((this.failed / this.total) * 100, 3) : 0,
      droppedRequests: this.dropped,
      plannedRequests: plan.plannedRequests,
      achievedRps: round(achievedRps, 2),
      targetRps: round(plan.targetRps, 3),
      measuredSec: round(measuredSec, 1),
      latency,
      statusCodes: this.statusCodes,
      timeouts: this.timeouts,
      networkErrors: this.networkErrors,
    };

    const series = this.buildSeries(spanSec);
    const verdict = buildVerdict(summary, config, status);
    return { summary, series, verdict };
  }

  private buildSeries(spanSec: number): SeriesPoint[] {
    const out: SeriesPoint[] = [];
    const n = this.buckets.length;
    for (let i = 0; i < n; i++) {
      const b = this.buckets[i];
      const start = i * this.bucketSec;
      const length = Math.min(this.bucketSec, Math.max(0, spanSec - start));
      const isLast = i === n - 1;
      // A trailing sliver of a bucket would show up as a misleading dip, so leave it out of the chart.
      if (isLast && n > 1 && length < this.bucketSec * 0.5) {
        continue;
      }
      const span = isLast && length > 0 ? length : this.bucketSec;
      const sorted = b.durations.length ? sortedCopy(b.durations) : null;
      out.push({
        t: start,
        rps: round(b.count / span, 2),
        failedRps: round(b.failed / span, 2),
        p50: sorted ? round(percentile(sorted, 50)) : null,
        p95: sorted ? round(percentile(sorted, 95)) : null,
      });
    }
    return out;
  }
}

export function buildVerdict(summary: ResultSummary, config: TestConfig, status: RunStatus): Verdict {
  const p95Actual = summary.latency ? summary.latency.p95 : null;
  const p95Passed = p95Actual !== null && p95Actual <= config.p95TargetMs;
  const errPassed = summary.totalRequests > 0 && summary.errorRatePct <= config.errorRateTargetPct;
  const keptUp = generatorKeptUp(summary, status);

  let overall: Verdict['overall'];
  if (summary.totalRequests === 0) {
    overall = 'incomplete';
  } else if (!p95Passed || !errPassed) {
    overall = 'fail';
  } else if (status !== 'completed' || !keptUp) {
    overall = 'incomplete';
  } else {
    overall = 'pass';
  }
  return {
    p95: { target: config.p95TargetMs, actual: p95Actual, passed: p95Passed },
    errorRate: { target: config.errorRateTargetPct, actual: summary.totalRequests ? summary.errorRatePct : null, passed: errPassed },
    generatorKeptUp: keptUp,
    overall,
  };
}

/** Did the traffic generator deliver (close to) the traffic that was asked for? */
export function generatorKeptUp(summary: ResultSummary, status: RunStatus): boolean {
  if (summary.droppedRequests > 0) {
    return false;
  }
  if (status !== 'completed') {
    return true; // a stopped run cannot be judged against the full target
  }
  return summary.targetRps <= 0 || summary.achievedRps >= summary.targetRps * 0.95;
}

function fmtMs(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function median(values: number[]): number {
  const s = Float64Array.from(values).sort();
  return percentile(s, 50);
}

/** Plain-language findings. Deliberately cautious: it states what was measured, not guesses about causes. */
export function buildInsights(args: {
  summary: ResultSummary;
  verdict: Verdict;
  config: TestConfig;
  series: SeriesPoint[];
  status: RunStatus;
  isLoopback: boolean;
}): Insight[] {
  const { summary, verdict, config, series, status, isLoopback } = args;
  const out: Insight[] = [];

  if (summary.totalRequests === 0) {
    out.push({
      level: 'bad',
      text: 'No requests completed, so there is nothing to measure. Check that the URL is reachable and that the application is running.',
    });
    return out;
  }

  if (status === 'stopped') {
    out.push({ level: 'info', text: 'The test was stopped early, so these figures cover only the part that ran.' });
  }

  // 1. Traffic actually delivered
  const pct = summary.targetRps > 0 ? Math.round((summary.achievedRps / summary.targetRps) * 100) : 100;
  if (verdict.generatorKeptUp) {
    out.push({
      level: 'good',
      text: `Sent ${plural(summary.totalRequests, 'request')} at ${summary.achievedRps} requests/second (target ${summary.targetRps}).`,
    });
  } else {
    const parts = [
      `Only ${summary.achievedRps} of the ${summary.targetRps} requests/second target was delivered (${pct}%).`,
    ];
    if (summary.droppedRequests > 0) {
      parts.push(
        `k6 skipped ${plural(summary.droppedRequests, 'scheduled request')} because it ran out of virtual users. That usually means responses were slow enough for requests to pile up, or this computer/network could not generate that much traffic.`,
      );
    }
    parts.push('Treat the response-time figures with care: the server saw less traffic than you asked for.');
    out.push({ level: 'warn', text: parts.join(' ') });
  }

  // 2. Response time vs target
  if (summary.latency) {
    const l = summary.latency;
    out.push({
      level: verdict.p95.passed ? 'good' : 'bad',
      text: `Half of requests finished within ${fmtMs(l.p50)}; 95% finished within ${fmtMs(l.p95)}, which ${
        verdict.p95.passed ? 'meets' : 'misses'
      } your ${fmtMs(config.p95TargetMs)} target. The slowest request took ${fmtMs(l.max)}.`,
    });
    if (l.p50 > 0 && l.p99 > l.p50 * 5 && l.p99 - l.p50 > 100) {
      out.push({
        level: 'info',
        text: `A small share of requests were much slower than typical: the slowest 1% took ${fmtMs(l.p99)} or more, against a median of ${fmtMs(l.p50)}.`,
      });
    }
  }

  // 3. Errors
  if (summary.failedRequests > 0) {
    const bits: string[] = [];
    const codes = Object.entries(summary.statusCodes)
      .filter(([code]) => code !== '0' && Number(code) >= 400)
      .sort((a, b) => b[1] - a[1]);
    for (const [code, count] of codes.slice(0, 4)) {
      bits.push(`HTTP ${code} ×${count.toLocaleString('en-US')}`);
    }
    if (summary.timeouts > 0) {
      bits.push(`timeouts ×${summary.timeouts.toLocaleString('en-US')}`);
    }
    if (summary.networkErrors > 0) {
      bits.push(`no connection ×${summary.networkErrors.toLocaleString('en-US')}`);
    }
    out.push({
      level: verdict.errorRate.passed ? 'warn' : 'bad',
      text: `${plural(summary.failedRequests, 'request')} failed (${summary.errorRatePct}%)${bits.length ? `: ${bits.join(', ')}` : ''}. Your target was at most ${config.errorRateTargetPct}%.`,
    });
    const has = (pred: (c: number) => boolean) => codes.some(([c]) => pred(Number(c)));
    if (summary.statusCodes['429']) {
      out.push({
        level: 'info',
        text: 'HTTP 429 means the server or its host is rate-limiting requests. The application may be fine; the limit may be protecting it from this test traffic.',
      });
    }
    if (has((c) => c >= 500)) {
      out.push({
        level: 'info',
        text: 'HTTP 5xx errors are server-side failures. This test shows they happened under this load, but not why — check the server logs for the same time window.',
      });
    }
    if (has((c) => c === 401 || c === 403 || c === 404)) {
      out.push({
        level: 'info',
        text: 'HTTP 401/403/404 usually mean the URL or required login is wrong rather than a load problem. Check the address, or that this endpoint needs no authentication.',
      });
    }
    if (summary.timeouts > 0) {
      out.push({
        level: 'info',
        text: `Timeouts mean no response arrived within ${config.timeoutSec} s. Under load this often means the server was overloaded or stalled.`,
      });
    }
    if (summary.networkErrors > 0) {
      out.push({
        level: 'info',
        text: 'Some requests never connected (connection refused, DNS failure or similar). Check that the application is running and the host name is correct.',
      });
    }
  } else {
    out.push({ level: 'good', text: 'No requests failed.' });
  }

  // 4. Shape over time
  const withP95 = series.filter((s) => s.p95 !== null) as Array<SeriesPoint & { p95: number }>;
  if (withP95.length >= 6) {
    const third = Math.floor(withP95.length / 3);
    const early = median(withP95.slice(0, third).map((s) => s.p95));
    const late = median(withP95.slice(-third).map((s) => s.p95));
    if (late > early * 1.5 && late - early > 50) {
      out.push({
        level: 'warn',
        text: `Response times grew as the test went on (typical p95 about ${fmtMs(early)} early, ${fmtMs(late)} late). That pattern is consistent with the server saturating, throttling, or running short of a resource. One test cannot tell which.`,
      });
    } else if (early > late * 1.5 && early - late > 50) {
      out.push({
        level: 'info',
        text: `The start was slower than the rest (typical p95 about ${fmtMs(early)} early, ${fmtMs(late)} late), which is typical of a warm-up, cold start or sleeping service. Free hosting tiers often behave this way.`,
      });
    }
  }
  if (series.length >= 4 && series[0].p95 !== null) {
    const rest = series.slice(1).filter((s) => s.p95 !== null).map((s) => s.p95 as number);
    if (rest.length >= 3) {
      const restMedian = median(rest);
      if (series[0].p95 > restMedian * 3 && series[0].p95 > 1000) {
        out.push({
          level: 'info',
          text: `The first moments were far slower (${fmtMs(series[0].p95)} p95) than the rest (${fmtMs(restMedian)}). If this is a free-tier or serverless host, the service may have been asleep and started up on the first requests.`,
        });
      }
    }
  }

  // 5. Context that affects how to read the numbers
  out.push({
    level: 'info',
    text: isLoopback
      ? 'The application and k6 ran on the same computer, so they competed for CPU and memory. Real traffic from other machines would not share that cost.'
      : 'Requests were sent from this computer, so the figures include the network path between you and the server. Another location or connection would give different numbers.',
  });
  return out;
}
