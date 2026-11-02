// Shared types. This file must not import "vscode" so it can be unit-tested in plain Node.

export type HttpMethod = 'GET' | 'HEAD';
export type TrafficMode = 'rate' | 'total';

/** What the person enters in the dashboard form (after validation/sanitising). */
export interface TestConfig {
  label: string;
  url: string;
  method: HttpMethod;
  mode: TrafficMode;
  /** Requests per second. Used when mode === 'rate'. */
  rate?: number;
  /** Total requests spread across the duration. Used when mode === 'total'. */
  totalRequests?: number;
  durationSec: number;
  /** Response-time target: the p95 should be at or below this many milliseconds. */
  p95TargetMs: number;
  /** Error-rate target: at most this percentage of requests may fail. */
  errorRateTargetPct: number;
  /** Per-request timeout in seconds. */
  timeoutSec: number;
  /** The person confirmed they own the target or have permission to test it. */
  confirmedPermission: boolean;
}

/** Derived values describing exactly what will be asked of k6. */
export interface TestPlan {
  targetRps: number;
  plannedRequests: number;
  k6Rate: number;
  k6TimeUnit: string;
  preAllocatedVUs: number;
  maxVUs: number;
}

export type RunStatus = 'completed' | 'stopped' | 'failed';

export interface LatencyStats {
  min: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  /** Number of requests the latency figures are based on. */
  samples: number;
}

export interface ResultSummary {
  totalRequests: number;
  failedRequests: number;
  errorRatePct: number;
  /** Requests k6 scheduled but could not start (it ran out of virtual users). */
  droppedRequests: number;
  plannedRequests: number;
  achievedRps: number;
  targetRps: number;
  /** Seconds the achieved rate is measured over. */
  measuredSec: number;
  /** Latency of requests that reached the server (or timed out). Null if none did. */
  latency: LatencyStats | null;
  /** HTTP status -> count. "0" means no HTTP response (network error or timeout). */
  statusCodes: Record<string, number>;
  timeouts: number;
  networkErrors: number;
}

export interface TargetCheck {
  target: number;
  actual: number | null;
  passed: boolean;
}

export interface Verdict {
  p95: TargetCheck;
  errorRate: TargetCheck;
  generatorKeptUp: boolean;
  overall: 'pass' | 'fail' | 'incomplete';
}

export interface SeriesPoint {
  /** Seconds since the first response. */
  t: number;
  rps: number;
  failedRps: number;
  p50: number | null;
  p95: number | null;
}

export type InsightLevel = 'good' | 'info' | 'warn' | 'bad';

export interface Insight {
  level: InsightLevel;
  text: string;
}

export interface TestResult {
  schemaVersion: 1;
  id: string;
  label: string;
  createdAt: string;
  startedAt: string;
  endedAt: string;
  status: RunStatus;
  config: TestConfig;
  plan: TestPlan;
  k6Version: string | null;
  summary: ResultSummary;
  verdict: Verdict;
  bucketSec: number;
  series: SeriesPoint[];
  insights: Insight[];
  errorMessage?: string;
}

/** Light-weight row for the history table. */
export interface ResultListItem {
  id: string;
  label: string;
  createdAt: string;
  status: RunStatus;
  url: string;
  method: HttpMethod;
  targetRps: number;
  durationSec: number;
  achievedRps: number;
  p95: number | null;
  errorRatePct: number;
  overall: Verdict['overall'];
}

export interface K6Status {
  ok: boolean;
  version: string | null;
  path: string;
  error?: string;
}

export type RunPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'processing';

export interface RunState {
  phase: RunPhase;
  elapsedSec: number;
  durationSec: number;
  label?: string;
  url?: string;
}
