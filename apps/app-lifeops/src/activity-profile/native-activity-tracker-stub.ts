/**
 * Stub for `@elizaos/native-activity-tracker`.
 *
 * The real package ships a native macOS binary that emits app/window events.
 * Until the native workspace is available, this stub lets the app build and
 * run with the collector reporting "disabled-non-darwin" everywhere.
 *
 * When the real package lands, replace the imports in:
 *   - activity-profile/activity-tracker-service.ts
 *   - actions/activity-report.ts
 * with `from "@elizaos/native-activity-tracker"`.
 */

export type ActivityCollectorEventKind = "activate" | "deactivate";

export interface ActivityCollectorEvent {
  ts: number;
  event: ActivityCollectorEventKind;
  bundleId: string;
  appName: string;
  windowTitle?: string;
}

export interface ActivityCollectorHandle {
  pid: number;
  stop(): Promise<void> | void;
}

export interface StartActivityCollectorOptions {
  onEvent: (event: ActivityCollectorEvent) => void;
  onFatal: (reason: string) => void;
}

export function isSupportedPlatform(): boolean {
  return false;
}

export function startActivityCollector(
  _options: StartActivityCollectorOptions,
): ActivityCollectorHandle {
  throw new Error(
    "[activity-tracker] native-activity-tracker binary is not available in this build",
  );
}
