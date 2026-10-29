/**
 * Renderer contract for the shared privacy-bounded problem log (`crash.CrashLog` on Android).
 *
 * Entries hold failure classes only: where the failure happened, Android's exit reason or an error
 * class name, and the time. Messages, stacks, URLs, component trees and user content are never
 * recorded, because any of them can carry note text, addresses or account data. Every value read
 * back from the native side or browser storage passes the same allowlist again before display or
 * export, so a damaged or older record can never surface more than this module would write.
 */

export type NativeCrashSource = "uncaught" | "exit" | "renderer";
export type RendererFailureKind = "render" | "startup" | "uncaught";
export type CrashExitReason =
  | "crash"
  | "native-crash"
  | "anr"
  | "low-memory"
  | "signaled"
  | "initialization-failure"
  | "excessive-resource-usage"
  | "dependency-died"
  | "freezer"
  | "other"
  | "unknown"
  | "exit-self";

export interface NativeCrashEntry {
  at: number;
  source: NativeCrashSource;
  kind?: RendererFailureKind;
  errorClass?: string;
  rootClass?: string;
  reason?: CrashExitReason;
  process?: string;
  thread?: "main" | "background";
}

/** Bridge shape a host exposes for the native log (method names are the host's registration). */
export interface CrashLogPort {
  crashLog(): Promise<{ entries?: unknown; exitHistory?: unknown }>;
  recordRendererFailure(input: {
    kind: RendererFailureKind;
    errorClass: string;
  }): Promise<void>;
  clearCrashLog(): Promise<void>;
}

export const CRASH_LOG_MAX_ENTRIES = 50;
export const CRASH_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const JAVA_CLASS = /^[A-Za-z_$][A-Za-z0-9_$.]{0,159}$/;
const JS_CLASS = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const PROCESS_LABEL = /^(main|other|:[A-Za-z0-9_]{1,40})$/;
export const CRASH_EXIT_REASONS: readonly CrashExitReason[] = [
  "crash",
  "native-crash",
  "anr",
  "low-memory",
  "signaled",
  "initialization-failure",
  "excessive-resource-usage",
  "dependency-died",
  "freezer",
  "other",
  "unknown",
  "exit-self",
];
export const RENDERER_FAILURE_KINDS: readonly RendererFailureKind[] = [
  "render",
  "startup",
  "uncaught",
];

/** Error class only. A name that is not a plain identifier (it could be text) becomes "Error". */
export function errorClassOf(error: unknown): string {
  if (error instanceof Error)
    return JS_CLASS.test(error.name) ? error.name : "Error";
  return error === null ? "null" : typeof error;
}

/** One native entry with allowlisted fields and shapes, or null. Anything else is dropped, never copied. */
export function sanitizeCrashEntry(
  raw: unknown,
  now = Date.now(),
): NativeCrashEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const at = item.at;
  if (
    typeof at !== "number" ||
    !Number.isSafeInteger(at) ||
    at <= now - CRASH_LOG_RETENTION_MS ||
    at > now + CRASH_LOG_RETENTION_MS
  )
    return null;
  if (
    item.source !== "uncaught" &&
    item.source !== "exit" &&
    item.source !== "renderer"
  )
    return null;
  const entry: NativeCrashEntry = { at, source: item.source };
  if (item.source === "renderer") {
    const kind = RENDERER_FAILURE_KINDS.find((value) => value === item.kind);
    if (!kind) return null;
    entry.kind = kind;
  }
  if (item.source === "exit") {
    const reason = CRASH_EXIT_REASONS.find((value) => value === item.reason);
    if (!reason) return null;
    entry.reason = reason;
  }
  const classPattern = item.source === "renderer" ? JS_CLASS : JAVA_CLASS;
  if (typeof item.errorClass === "string" && classPattern.test(item.errorClass))
    entry.errorClass = item.errorClass;
  if (
    item.source === "uncaught" &&
    typeof item.rootClass === "string" &&
    JAVA_CLASS.test(item.rootClass)
  )
    entry.rootClass = item.rootClass;
  if (typeof item.process === "string" && PROCESS_LABEL.test(item.process))
    entry.process = item.process;
  if (item.thread === "main" || item.thread === "background")
    entry.thread = item.thread;
  return entry;
}

/** Retained, allowlisted entries in time order, bounded to {@link CRASH_LOG_MAX_ENTRIES}. */
export function sanitizeCrashEntries(
  value: unknown,
  now = Date.now(),
): NativeCrashEntry[] {
  if (!Array.isArray(value)) return [];
  const out: NativeCrashEntry[] = [];
  for (const raw of value) {
    const entry = sanitizeCrashEntry(raw, now);
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => a.at - b.at).slice(-CRASH_LOG_MAX_ENTRIES);
}

/** Reads the native log through a host port; a missing or failing port reads as empty. */
export async function readNativeCrashLog(
  port: CrashLogPort | null | undefined,
  now = Date.now(),
): Promise<{ entries: NativeCrashEntry[]; exitHistory: boolean }> {
  if (!port) return { entries: [], exitHistory: false };
  const result = await port.crashLog();
  return {
    entries: sanitizeCrashEntries(result?.entries, now),
    exitHistory: result?.exitHistory === true,
  };
}

/** One line per entry for a Settings diagnostics list: what failed, and its class or reason. */
export function describeNativeCrashEntry(entry: NativeCrashEntry): {
  title: string;
  detail: string;
} {
  const where =
    entry.process && entry.process !== "main"
      ? ` · ${entry.process} process`
      : "";
  if (entry.source === "exit")
    return {
      title: `App process stopped: ${entry.reason}`,
      detail: `Reported by Android${where}`,
    };
  if (entry.source === "renderer")
    return {
      title: `Screen failure: ${entry.kind}`,
      detail: entry.errorClass || "Error",
    };
  return {
    title: "App crashed",
    detail:
      [
        entry.errorClass,
        entry.rootClass && entry.rootClass !== entry.errorClass
          ? `caused by ${entry.rootClass}`
          : "",
        entry.thread ? `${entry.thread} thread` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "Unknown class",
  };
}

/**
 * The redacted export document for a support bundle: version, export time and the allowlisted
 * entries only (re-sanitized here, whatever the caller passes).
 */
export function exportCrashLog(
  entries: unknown,
  now = Date.now(),
): { version: 1; exportedAt: number; entries: NativeCrashEntry[] } {
  return {
    version: 1,
    exportedAt: now,
    entries: sanitizeCrashEntries(entries, now),
  };
}
