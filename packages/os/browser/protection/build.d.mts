import type { ReputationFeed } from "./reputation.d.mts";

export type WarningCopyKey = "title" | "heading" | "stopped" | "mistake" | "feeds" | "limits";

export interface ProtectionOptions {
  warningDirectory?: string;
  warning?: { assistantName?: string; copy?: Partial<Record<WarningCopyKey, string>> };
  feeds?: readonly ReputationFeed[];
  neverBlock?: string[];
  refreshAlarm?: string;
  exceptionAlarm?: string;
  advisory?: { referenceDomains?: string[]; copy?: Record<string, string>; unscanned?: boolean; unscannedWhileLoading?: boolean };
}

export function warningCopy(
  warning?: ProtectionOptions["warning"],
  feeds?: readonly ReputationFeed[],
): Record<WarningCopyKey, string>;
export function renderWarningPage(template: string, values: Readonly<Record<string, string>>): string;
export function buildBrowserProtection(
  output: string,
  options?: ProtectionOptions,
): Promise<{ output: string; installed: false; signed: false }>;
export function composeProtectionAssets(
  assets: Record<string, Buffer>,
  options?: ProtectionOptions & { nativeAccountTransport?: boolean },
): Promise<Record<string, Buffer>>;
