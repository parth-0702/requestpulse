import * as vscode from 'vscode';
import { Controller } from './controller';
import { DashboardPanel } from './dashboard';
import { checkK6 } from './k6';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new Controller(context);
  context.subscriptions.push(controller);

  context.subscriptions.push(
    vscode.commands.registerCommand('requestpulse.openDashboard', () => {
      DashboardPanel.createOrShow(context, controller);
    }),

    vscode.commands.registerCommand('requestpulse.stopTest', () => {
      controller.stop();
    }),

    vscode.commands.registerCommand('requestpulse.openReportsFolder', async () => {
      await controller.openReportsFolder();
    }),

    vscode.commands.registerCommand('requestpulse.checkK6', async () => {
      const k6Path = vscode.workspace.getConfiguration('requestpulse').get<string>('k6Path', 'k6') || 'k6';
      const status = await checkK6(k6Path);
      if (status.ok) {
        void vscode.window.showInformationMessage(`RequestPulse: k6 ${status.version} is installed and ready.`);
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `RequestPulse: ${status.error ?? 'k6 is not available.'} RequestPulse needs k6 to generate traffic.`,
        'Open install guide',
      );
      if (choice === 'Open install guide') {
        controller.openInstallGuide();
      }
    }),
  );
}

export function deactivate(): void {
  // The Controller is disposed through context.subscriptions, which also stops any running k6 process.
}
