import { ChildProcess, execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Aggregator, buildInsights } from './results';
import { K6Status, RunPhase, TestConfig, TestPlan, TestResult } from './types';
import { isLoopbackHost } from './validate';

/** Ask the installed k6 for its version. Never throws. */
export function checkK6(k6Path: string): Promise<K6Status> {
  return new Promise((resolve) => {
    const cmd = k6Path.trim() || 'k6';
    try {
      execFile(cmd, ['version'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          resolve({
            ok: false,
            version: null,
            path: cmd,
            error:
              code === 'ENOENT'
                ? `k6 was not found (looked for "${cmd}").`
                : `k6 could not be run: ${err.message.split('\n')[0]}`,
          });
          return;
        }
        const m = /v?(\d+\.\d+\.\d+)/.exec(String(stdout));
        if (!m || !/k6/i.test(String(stdout))) {
          resolve({ ok: false, version: null, path: cmd, error: `"${cmd}" ran but does not look like k6.` });
          return;
        }
        resolve({ ok: true, version: m[1], path: cmd });
      });
    } catch (e) {
      resolve({ ok: false, version: null, path: cmd, error: `k6 could not be run: ${(e as Error).message}` });
    }
  });
}

/** Arguments are passed as an array to spawn() with no shell, so nothing is ever parsed as a command line. */
export function buildK6Args(scriptPath: string, jsonOutPath: string): string[] {
  return [
    'run',
    '--quiet',
    '--no-color',
    '--no-usage-report',
    '--system-tags=status,error_code',
    '--out',
    `json=${jsonOutPath}`,
    scriptPath,
  ];
}

export function buildK6Env(config: TestConfig, plan: TestPlan, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    RP_URL: config.url,
    RP_METHOD: config.method,
    RP_RATE: String(plan.k6Rate),
    RP_TIME_UNIT: plan.k6TimeUnit,
    RP_DURATION_SEC: String(config.durationSec),
    RP_TIMEOUT_SEC: String(config.timeoutSec),
    RP_PREALLOC_VUS: String(plan.preAllocatedVUs),
    RP_MAX_VUS: String(plan.maxVUs),
    K6_NO_USAGE_REPORT: 'true',
  };
}

export function makeResultId(now = new Date()): string {
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 19).replace(/:/g, '');
  return `${date}-${time}-${crypto.randomBytes(2).toString('hex')}`;
}

/** A failure the person can act on (as opposed to a bug). */
export class RunError extends Error {}

export interface RunHooks {
  onPhase?: (phase: RunPhase) => void;
  /** Called about twice a second while the test runs. */
  onProgress?: (elapsedSec: number) => void;
}

export interface RunOptions extends RunHooks {
  k6Path: string;
  k6Version: string | null;
  scriptPath: string;
  /** Scratch directory for k6's raw output. Files here are deleted after each run. */
  workDir: string;
}

export interface RunHandle {
  id: string;
  /** Ask k6 to stop. The partial results are still processed. */
  stop(): void;
  result: Promise<TestResult>;
}

async function readLines(file: string, onLine: (line: string) => void): Promise<boolean> {
  let stream: fs.ReadStream;
  try {
    await fs.promises.access(file);
    stream = fs.createReadStream(file, { encoding: 'utf8' });
  } catch {
    return false;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    onLine(line);
  }
  return true;
}

export function startTest(config: TestConfig, plan: TestPlan, opts: RunOptions): RunHandle {
  const id = makeResultId();
  const outFile = path.join(opts.workDir, `${id}.ndjson`);
  const startedAt = new Date();
  let stopRequested = false;
  let finished = false;
  let stderrTail: string[] = [];
  let killTimer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;
  let runningSince: number | null = null;
  let timedOut = false;

  const timers: NodeJS.Timeout[] = [];
  const clearTimers = () => {
    timers.forEach((t) => clearInterval(t));
    timers.forEach((t) => clearTimeout(t));
    if (killTimer) {
      clearTimeout(killTimer);
    }
  };

  const result = new Promise<TestResult>((resolve, reject) => {
    fs.mkdirSync(opts.workDir, { recursive: true });
    opts.onPhase?.('starting');

    try {
      child = spawn(opts.k6Path.trim() || 'k6', buildK6Args(opts.scriptPath, outFile), {
        cwd: opts.workDir,
        env: buildK6Env(config, plan),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new RunError(`Could not start k6: ${(e as Error).message}`));
      return;
    }

    child.stdout?.resume(); // k6 prints nothing we need; just keep the pipe drained

    let pending = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        // k6 logs one warning per failed request; keep those out of the diagnostic tail.
        if (line.trim() && !line.includes('Request Failed')) {
          stderrTail.push(line.trim());
        }
      }
      if (stderrTail.length > 20) {
        stderrTail = stderrTail.slice(-20);
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimers();
      reject(
        new RunError(
          err.code === 'ENOENT'
            ? 'k6 was not found. Install k6 and make sure it is on your PATH (or set "requestpulse.k6Path").'
            : `Could not start k6: ${err.message}`,
        ),
      );
    });

    // Detect when k6 has begun sending traffic (its output file starts filling up).
    const poll = setInterval(async () => {
      if (finished) {
        return;
      }
      if (runningSince === null) {
        try {
          const st = await fs.promises.stat(outFile);
          if (st.size > 0) {
            runningSince = Date.now();
            if (!stopRequested) {
              opts.onPhase?.('running');
            }
          }
        } catch {
          /* not created yet */
        }
      }
      if (runningSince !== null && !stopRequested) {
        opts.onProgress?.(Math.min(config.durationSec, (Date.now() - runningSince) / 1000));
      }
    }, 500);
    timers.push(poll);

    // Safety net: never leave k6 running forever.
    const watchdog = setTimeout(() => {
      timedOut = true;
      child?.kill('SIGKILL');
    }, (config.durationSec + config.timeoutSec + 90) * 1000);
    timers.push(watchdog);

    child.on('close', async (code, signal) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimers();
      opts.onPhase?.('processing');
      const endedAt = new Date();
      try {
        const agg = new Aggregator(config.durationSec);
        const hadFile = await readLines(outFile, (line) => agg.addLine(line));
        // The raw output can be large; remove it as soon as it has been read, before anything is returned.
        await fs.promises.rm(outFile, { force: true }).catch(() => undefined);
        const wallSec = (endedAt.getTime() - startedAt.getTime()) / 1000;

        let status: TestResult['status'] = 'completed';
        let errorMessage: string | undefined;
        if (stopRequested) {
          status = 'stopped';
        } else if (code !== 0) {
          status = 'failed';
          errorMessage = timedOut
            ? 'k6 did not finish in the expected time and was stopped.'
            : failureMessage(code, signal, stderrTail);
        }

        const { summary, series, verdict } = agg.finish({ config, plan, status, wallSec });

        if (summary.totalRequests === 0 && status !== 'completed') {
          reject(
            new RunError(
              status === 'stopped'
                ? 'The test was stopped before any request completed, so there is nothing to show.'
                : errorMessage ?? 'k6 stopped without producing any results.',
            ),
          );
          return;
        }
        if (!hadFile && status === 'completed') {
          reject(new RunError('k6 finished but wrote no results. Please try again.'));
          return;
        }

        const insights = buildInsights({
          summary,
          verdict,
          config,
          series,
          status,
          isLoopback: isLoopbackHost(new URL(config.url).hostname),
        });
        if (errorMessage) {
          insights.unshift({ level: 'bad', text: `k6 ended unexpectedly, so these results are partial. ${errorMessage}` });
        }

        resolve({
          schemaVersion: 1,
          id,
          label: config.label,
          createdAt: endedAt.toISOString(),
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          status,
          config,
          plan,
          k6Version: opts.k6Version,
          summary,
          verdict,
          bucketSec: agg.bucketSec,
          series,
          insights,
          ...(errorMessage ? { errorMessage } : {}),
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        fs.promises.rm(outFile, { force: true }).catch(() => undefined);
      }
    });
  });

  return {
    id,
    result,
    stop() {
      if (finished || stopRequested || !child) {
        return;
      }
      stopRequested = true;
      opts.onPhase?.('stopping');
      if (process.platform === 'win32') {
        child.kill(); // Windows has no graceful signal for child processes
      } else {
        child.kill('SIGINT'); // lets k6 flush the results gathered so far
        killTimer = setTimeout(() => child?.kill('SIGKILL'), 8000);
      }
    },
  };
}

function failureMessage(code: number | null, signal: NodeJS.Signals | null, tail: string[]): string {
  const detail = tail
    .slice(-4)
    .join(' ')
    .replace(/time="[^"]*"\s*/g, '')
    .replace(/level=\w+\s*/g, '')
    .slice(0, 400);
  const how = signal ? `was ended by signal ${signal}` : `exited with code ${code}`;
  return detail ? `k6 ${how}: ${detail}` : `k6 ${how}.`;
}
