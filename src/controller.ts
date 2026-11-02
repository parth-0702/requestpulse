import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { checkK6, RunError, RunHandle, startTest } from './k6';
import { ResultStore, isValidResultId } from './storage';
import { K6Status, RunPhase, RunState, TestConfig } from './types';
import { DEFAULTS, LIMITS, validateConfig } from './validate';

const LAST_CONFIG_KEY = 'requestpulse.lastConfig';
const K6_INSTALL_URL = 'https://grafana.com/docs/k6/latest/set-up/install-k6/';

type Sink = (message: unknown) => void;

/**
 * Owns everything that is not UI: the saved-results store, the running k6 process, and the state
 * the dashboard displays. The dashboard talks to it through handleMessage().
 */
export class Controller implements vscode.Disposable {
  private readonly store: ResultStore;
  private readonly workDir: string;
  private readonly statusBar: vscode.StatusBarItem;
  private sink: Sink | undefined;
  private panelVisible: () => boolean = () => false;
  private run: RunHandle | undefined;
  private runState: RunState = { phase: 'idle', elapsedSec: 0, durationSec: 0 };
  private k6: K6Status | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const base = context.globalStorageUri.fsPath;
    this.store = new ResultStore(path.join(base, 'results'));
    this.workDir = path.join(base, 'work');
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.statusBar.command = 'requestpulse.stopTest';
    this.statusBar.tooltip = 'RequestPulse is running a load test. Click to stop it.';
    this.cleanWorkDir();
  }

  get reportsDir(): string {
    return this.store.dir;
  }

  get isRunning(): boolean {
    return this.run !== undefined;
  }

  setSink(sink: Sink | undefined, isVisible: () => boolean = () => false): void {
    this.sink = sink;
    this.panelVisible = isVisible;
  }

  private post(message: unknown): void {
    this.sink?.(message);
  }

  private k6Path(): string {
    return vscode.workspace.getConfiguration('requestpulse').get<string>('k6Path', 'k6') || 'k6';
  }

  async refreshK6(): Promise<K6Status> {
    this.k6 = await checkK6(this.k6Path());
    this.post({ type: 'k6Status', status: this.k6 });
    return this.k6;
  }

  openInstallGuide(): void {
    void vscode.env.openExternal(vscode.Uri.parse(K6_INSTALL_URL));
  }

  async sendInit(): Promise<void> {
    const last = this.context.globalState.get<Partial<TestConfig>>(LAST_CONFIG_KEY);
    const defaults: TestConfig = { ...DEFAULTS, ...(last ?? {}), confirmedPermission: false };
    this.post({
      type: 'init',
      defaults,
      limits: LIMITS,
      platform: process.platform,
      k6: this.k6 ?? null,
      run: this.runState,
      history: await this.store.list(),
    });
    if (!this.k6) {
      void this.refreshK6();
    }
  }

  async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case 'ready':
        await this.sendInit();
        break;
      case 'start':
        await this.start(m.config);
        break;
      case 'stop':
        this.stop();
        break;
      case 'recheckK6':
        await this.refreshK6();
        break;
      case 'openK6Docs':
        this.openInstallGuide();
        break;
      case 'copyText':
        if (typeof m.text === 'string' && m.text.length <= 200) {
          await vscode.env.clipboard.writeText(m.text);
          this.post({ type: 'notice', level: 'info', text: 'Copied to clipboard.' });
        }
        break;
      case 'getResult': {
        const result = isValidResultId(m.id) ? await this.store.get(m.id) : null;
        this.post({ type: 'resultData', purpose: String(m.purpose ?? 'view'), id: m.id, result });
        break;
      }
      case 'deleteResult':
        await this.deleteResult(m.id);
        break;
      case 'refreshHistory':
        this.post({ type: 'history', items: await this.store.list() });
        break;
      case 'openReportsFolder':
        await this.openReportsFolder();
        break;
    }
  }

  async openReportsFolder(): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(this.store.dir));
    await vscode.env.openExternal(vscode.Uri.file(this.store.dir));
  }

  private async deleteResult(id: unknown): Promise<void> {
    if (!isValidResultId(id)) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      'Delete this saved test result? This cannot be undone.',
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') {
      return;
    }
    await this.store.delete(id);
    this.post({ type: 'history', items: await this.store.list() });
  }

  private setPhase(phase: RunPhase, extra: Partial<RunState> = {}): void {
    this.runState = { ...this.runState, ...extra, phase };
    if (phase === 'idle') {
      this.runState = { phase: 'idle', elapsedSec: 0, durationSec: 0 };
      this.statusBar.hide();
    } else {
      this.statusBar.text =
        phase === 'processing'
          ? '$(loading~spin) RequestPulse: processing results…'
          : phase === 'stopping'
            ? '$(loading~spin) RequestPulse: stopping…'
            : '$(sync~spin) RequestPulse: load test running (click to stop)';
      this.statusBar.show();
    }
    this.post({ type: 'runState', run: this.runState });
  }

  private async start(rawConfig: unknown): Promise<void> {
    if (this.run) {
      this.post({ type: 'notice', level: 'warn', text: 'A test is already running. Stop it first.' });
      return;
    }
    const v = validateConfig(rawConfig);
    if (!v.ok) {
      this.post({ type: 'validationErrors', errors: v.errors });
      return;
    }
    this.post({ type: 'validationErrors', errors: [] });

    const k6 = await this.refreshK6();
    if (!k6.ok) {
      this.post({
        type: 'notice',
        level: 'error',
        text: k6.error ?? 'k6 is not available.',
      });
      return;
    }

    const { config, plan } = v;
    await this.context.globalState.update(LAST_CONFIG_KEY, { ...config, confirmedPermission: false });

    const scriptPath = this.context.asAbsolutePath(path.join('k6', 'requestpulse.js'));
    this.setPhase('starting', { durationSec: config.durationSec, elapsedSec: 0, label: config.label, url: config.url });

    let handle: RunHandle;
    try {
      handle = startTest(config, plan, {
        k6Path: this.k6Path(),
        k6Version: k6.version,
        scriptPath,
        workDir: this.workDir,
        onPhase: (p) => {
          if (this.run) {
            this.setPhase(p);
          }
        },
        onProgress: (elapsedSec) => {
          this.runState = { ...this.runState, elapsedSec };
          this.post({ type: 'runState', run: this.runState });
        },
      });
    } catch (e) {
      this.setPhase('idle');
      this.post({ type: 'notice', level: 'error', text: (e as Error).message });
      return;
    }
    this.run = handle;

    try {
      const result = await handle.result;
      await this.store.save(result);
      this.run = undefined;
      this.setPhase('idle');
      this.post({ type: 'result', result });
      this.post({ type: 'history', items: await this.store.list() });
      if (!this.panelVisible()) {
        this.notifyFinished(result.verdict.overall, result.summary.latency?.p95 ?? null, result.summary.errorRatePct, result.status);
      }
    } catch (e) {
      this.run = undefined;
      this.setPhase('idle');
      const text = e instanceof RunError ? e.message : `Something went wrong while running the test: ${(e as Error).message}`;
      this.post({ type: 'notice', level: 'error', text });
      if (!this.panelVisible()) {
        void vscode.window.showErrorMessage(`RequestPulse: ${text}`);
      }
    }
  }

  private notifyFinished(overall: string, p95: number | null, errPct: number, status: string): void {
    const verdict =
      overall === 'pass' ? 'all targets met' : overall === 'fail' ? 'targets missed' : status === 'stopped' ? 'stopped early' : 'incomplete';
    const detail = p95 === null ? '' : ` — p95 ${Math.round(p95)} ms, ${errPct}% errors`;
    void vscode.window
      .showInformationMessage(`RequestPulse: test finished (${verdict})${detail}`, 'Open Dashboard')
      .then((choice) => {
        if (choice === 'Open Dashboard') {
          void vscode.commands.executeCommand('requestpulse.openDashboard');
        }
      });
  }

  stop(): void {
    if (!this.run) {
      void vscode.window.showInformationMessage('RequestPulse: no test is running.');
      return;
    }
    this.run.stop();
  }

  /** Remove raw k6 output left behind by a crash. */
  private cleanWorkDir(): void {
    try {
      for (const f of fs.readdirSync(this.workDir)) {
        if (f.endsWith('.ndjson')) {
          fs.rmSync(path.join(this.workDir, f), { force: true });
        }
      }
    } catch {
      /* folder does not exist yet */
    }
  }

  dispose(): void {
    this.run?.stop();
    this.statusBar.dispose();
  }
}
