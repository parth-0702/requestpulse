import * as fs from 'fs';
import * as path from 'path';
import { ResultListItem, TestResult } from './types';

const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const FILE_PATTERN = /^(\d{8}-\d{6}-[0-9a-f]{4})\.json$/;
const MAX_LISTED = 200;

export function isValidResultId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function looksLikeResult(r: unknown): r is TestResult {
  const x = r as Partial<TestResult> | null;
  return !!x && x.schemaVersion === 1 && typeof x.id === 'string' && !!x.config && !!x.summary && !!x.verdict && Array.isArray(x.series);
}

export function toListItem(r: TestResult): ResultListItem {
  return {
    id: r.id,
    label: r.label,
    createdAt: r.createdAt,
    status: r.status,
    url: r.config.url,
    method: r.config.method,
    targetRps: r.summary.targetRps,
    durationSec: r.config.durationSec,
    achievedRps: r.summary.achievedRps,
    p95: r.summary.latency ? r.summary.latency.p95 : null,
    errorRatePct: r.summary.errorRatePct,
    overall: r.verdict.overall,
  };
}

/** Saved results: one JSON file per test in a local folder. Nothing leaves this computer. */
export class ResultStore {
  constructor(readonly dir: string) {}

  private ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(id: string): string {
    if (!isValidResultId(id)) {
      throw new Error('Invalid result id.');
    }
    return path.join(this.dir, `${id}.json`);
  }

  async save(result: TestResult): Promise<void> {
    this.ensure();
    const file = this.fileFor(result.id);
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async get(id: string): Promise<TestResult | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(this.fileFor(id), 'utf8'));
      return looksLikeResult(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    await fs.promises.rm(this.fileFor(id), { force: true });
  }

  /** Newest first. Unreadable or hand-edited files are skipped rather than breaking the list. */
  async list(): Promise<ResultListItem[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const ids = names
      .map((n) => FILE_PATTERN.exec(n)?.[1])
      .filter((x): x is string => !!x)
      .sort()
      .reverse()
      .slice(0, MAX_LISTED);
    const items: ResultListItem[] = [];
    for (const id of ids) {
      const r = await this.get(id);
      if (r) {
        items.push(toListItem(r));
      }
    }
    return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}
