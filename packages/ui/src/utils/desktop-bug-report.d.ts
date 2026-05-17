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
export declare function loadDesktopBugReportDiagnostics(): Promise<DesktopBugReportDiagnostics | null>;
export declare function openDesktopLogsFolder(): Promise<void>;
export declare function createDesktopBugReportBundle(options: {
    reportMarkdown: string;
    reportJson: Record<string, unknown>;
    prefix?: string;
}): Promise<DesktopBugReportBundleInfo | null>;
export declare function formatDesktopBugReportDiagnostics(diagnostics: DesktopBugReportDiagnostics): string;
//# sourceMappingURL=desktop-bug-report.d.ts.map