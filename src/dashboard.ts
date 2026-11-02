import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Controller } from './controller';

/** The single dashboard tab. Charts and forms are drawn by media/dashboard.js inside the webview. */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  static createOrShow(context: vscode.ExtensionContext, controller: Controller): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('requestpulse.dashboard', 'RequestPulse', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    });
    panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icon.png');
    DashboardPanel.current = new DashboardPanel(panel, mediaRoot, controller);
  }

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    mediaRoot: vscode.Uri,
    private readonly controller: Controller,
  ) {
    panel.webview.html = renderHtml(panel.webview, mediaRoot);

    controller.setSink(
      (message) => void panel.webview.postMessage(message),
      () => panel.visible && panel.active,
    );
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg) => {
        void controller.handleMessage(msg).catch((err) => {
          void vscode.window.showErrorMessage(`RequestPulse: ${(err as Error).message}`);
        });
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    this.controller.setSink(undefined);
    this.disposables.forEach((d) => d.dispose());
  }
}

function renderHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'dashboard.css'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>RequestPulse</title>
</head>
<body>
  <div id="app"><p class="muted">Loading RequestPulse…</p></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
