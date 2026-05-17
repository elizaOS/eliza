import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../bridge";

export interface DesktopBugReportDiagnostics {
  state: "not_started" | "starting" | "running" | "stopped" | "error";
  phase: string;
  updatedAt: string;
  lastError: string | null;
  agentName: string | null;
  port: number | null;
  startedAt: number | null;
  platform: string;
  arch: string;
  configDir: string;
  logPath: string;
  statusPath: string;
  logTail: string;
  appVersion?: string;
  appRuntime?: string;
  packaged?: boolean;
  locale?: string;
}

export interface DesktopBugReportBundleInfo {
  directory: string;
  reportMarkdownPath: string;
  reportJsonPath: string;
  startupLogPath: string | null;
  startupStatusPath: string | null;
}

export async function loadDesktopBugReportDiagnostics(): Promise<DesktopBugReportDiagnostics | null> {
  if (!isElectrobunRuntime()) {
    return null;
  }
  return invokeDesktopBridgeRequest<DesktopBugReportDiagnostics>({
    rpcMethod: "desktopGetStartupDiagnostics",
    ipcChannel: "desktop:getStartupDiagnostics",
  });
}

export async function openDesktopLogsFolder(): Promise<void> {
  if (!isElectrobunRuntime()) {
    return;
  }
  await invokeDesktopBridgeRequest<void>({
    rpcMethod: "desktopOpenLogsFolder",
    ipcChannel: "desktop:openLogsFolder",
  });
}

export async function createDesktopBugReportBundle(options: {
  reportMarkdown: string;
  reportJson: Record<string, unknown>;
  prefix?: string;
}): Promise<DesktopBugReportBundleInfo | null> {
  if (!isElectrobunRuntime()) {
    return null;
  }
  return invokeDesktopBridgeRequest<DesktopBugReportBundleInfo>({
    rpcMethod: "desktopCreateBugReportBundle",
    ipcChannel: "desktop:createBugReportBundle",
    params: options,
  });
}

export function formatDesktopBugReportDiagnostics(
  diagnostics: DesktopBugReportDiagnostics,
): string {
  const lines = [
    `App Version: ${diagnostics.appVersion ?? "unknown"}`,
    `Runtime: ${diagnostics.appRuntime ?? "unknown"}`,
    `Packaged: ${diagnostics.packaged == null ? "unknown" : diagnostics.packaged ? "yes" : "no"}`,
    `Platform: ${diagnostics.platform} ${diagnostics.arch}`,
    `Locale: ${diagnostics.locale ?? "unknown"}`,
    `Startup State: ${diagnostics.state}`,
    `Startup Phase: ${diagnostics.phase}`,
    `Last Error: ${diagnostics.lastError ?? "none"}`,
    `Agent Name: ${diagnostics.agentName ?? "unknown"}`,
    `Port: ${diagnostics.port ?? "unknown"}`,
    `Updated At: ${diagnostics.updatedAt}`,
    `Log Path: ${diagnostics.logPath}`,
    `Status Path: ${diagnostics.statusPath}`,
  ];
  return lines.join("\n");
}
