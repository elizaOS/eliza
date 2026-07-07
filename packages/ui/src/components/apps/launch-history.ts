/**
 * Ring buffer of recent app launch attempts for the App Details diagnostics
 * panel. Persisted to localStorage as a single array — capped at MAX entries.
 */

import type { AppLaunchDiagnostic } from "../../api";
import { shellLocalStorage } from "../../surface-realm-channel";

export interface LaunchAttemptRecord {
  timestamp: number;
  appName: string;
  succeeded: boolean;
  diagnostics: AppLaunchDiagnostic[];
  errorMessage?: string;
}

const KEY = "eliza:apps:launch-history";
const MAX = 20;

function isDiagnostic(value: unknown): value is AppLaunchDiagnostic {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.message === "string" &&
    (candidate.severity === "info" ||
      candidate.severity === "warning" ||
      candidate.severity === "error")
  );
}

function isRecord(value: unknown): value is LaunchAttemptRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.timestamp !== "number") return false;
  if (typeof candidate.appName !== "string") return false;
  if (typeof candidate.succeeded !== "boolean") return false;
  if (!Array.isArray(candidate.diagnostics)) return false;
  if (
    candidate.errorMessage !== undefined &&
    typeof candidate.errorMessage !== "string"
  ) {
    return false;
  }
  return candidate.diagnostics.every(isDiagnostic);
}

function loadAll(): LaunchAttemptRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    // error-policy:J3 corrupt/unavailable launch-history store — start with
    // an empty diagnostic history.
    return [];
  }
}

function saveAll(records: LaunchAttemptRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = records.slice(0, MAX);
    shellLocalStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // error-policy:J7 diagnostics write — sandboxed storage must not break
    // app launches; the in-memory history for this session is unaffected.
  }
}

export function recordLaunchAttempt(record: LaunchAttemptRecord): void {
  const existing = loadAll();
  saveAll([record, ...existing].slice(0, MAX));
}

export function getLaunchHistoryForApp(appName: string): LaunchAttemptRecord[] {
  return loadAll().filter((record) => record.appName === appName);
}

export function clearLaunchHistory(): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
