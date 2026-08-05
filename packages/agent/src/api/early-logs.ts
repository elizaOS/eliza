/**
 * Buffers structured logs emitted before the API server can expose them.
 * The logger listener API preserves logger ownership and provides an explicit
 * handoff when the server installs its long-lived capture listener.
 */

import {
  addLogListener,
  type LogEntry as StructuredLogEntry,
} from "@elizaos/core";
import type { LogEntry } from "@elizaos/shared";

export type { LogEntry as EarlyLogEntry };

const LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  27: "success",
  28: "progress",
  29: "log",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};
const ADZE_PRETTY_PREFIX =
  /^\s*(?:trace|debug|verbose|success|progress|log|info|warn|error|fatal|alert)\s{2,}/i;

function isAdzeRenderedMirror(entry: StructuredLogEntry): boolean {
  // Adze's configured levels occupy 1-8; elizaOS invocation entries use the
  // transport scale 10-60. Prefer that stable signal because colorized Linux
  // output can place ANSI escapes before the human-readable level prefix.
  return (
    (entry.level !== undefined && entry.level < 10) ||
    ADZE_PRETTY_PREFIX.test(entry.msg)
  );
}

let earlyLogBuffer: LogEntry[] | null = null;
let stopEarlyCapture: (() => void) | null = null;

/** Converts logger-package entries into the API's stable transport shape. */
export function formatStructuredLogEntry(entry: StructuredLogEntry): LogEntry {
  const metadata = entry as StructuredLogEntry & Record<string, unknown>;
  const bracketSource = /^\[([^\]]+)\]\s*/.exec(entry.msg)?.[1];
  const source =
    typeof metadata.src === "string"
      ? metadata.src
      : (bracketSource ?? "agent");
  const structuredTags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

  return {
    timestamp: entry.time,
    level: LEVEL_NAMES[entry.level ?? 30] ?? "info",
    message: entry.msg,
    source,
    tags: [...new Set(["agent", ...structuredTags, source])],
  };
}

/**
 * Subscribes to one logical entry per logger call. The logger currently emits
 * both its invocation entry and Adze's rendered mirror to the global listener;
 * only the invocation entry belongs in the API transport.
 */
export function listenForUiLogs(
  onEntry: (entry: LogEntry) => void,
): () => void {
  return addLogListener((entry) => {
    if (isAdzeRenderedMirror(entry)) return;
    onEntry(formatStructuredLogEntry(entry));
  });
}

/** Starts idempotent capture for the pre-server portion of agent startup. */
export function captureEarlyLogs(): void {
  if (earlyLogBuffer) return;

  earlyLogBuffer = [];
  stopEarlyCapture = listenForUiLogs((entry) => {
    earlyLogBuffer?.push(entry);
  });
}

/** Drains captured entries and releases the pre-server logger listener. */
export function flushEarlyLogs(): LogEntry[] {
  const entries = earlyLogBuffer ? [...earlyLogBuffer] : [];
  stopEarlyCapture?.();
  stopEarlyCapture = null;
  earlyLogBuffer = null;
  return entries;
}
