/**
 * Ring buffer of recent app launch attempts for the App Details diagnostics
 * panel. Persisted to localStorage as a single array — capped at MAX entries.
 */
import type { AppLaunchDiagnostic } from "../../api";
export interface LaunchAttemptRecord {
    timestamp: number;
    appName: string;
    succeeded: boolean;
    diagnostics: AppLaunchDiagnostic[];
    errorMessage?: string;
}
export declare function recordLaunchAttempt(record: LaunchAttemptRecord): void;
export declare function getLaunchHistoryForApp(appName: string): LaunchAttemptRecord[];
export declare function clearLaunchHistory(): void;
//# sourceMappingURL=launch-history.d.ts.map