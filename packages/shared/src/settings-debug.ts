/**
 * Opt-in verbose logging for settings load / change / save flows.
 * Enable with ELIZA_SETTINGS_DEBUG=1 (and Vite: same env at build time, or VITE_ELIZA_SETTINGS_DEBUG=1).
 */

import { isTruthyEnvValue } from "./env-utils.js";

/** Keys whose values are always redacted in debug dumps. */
const SENSITIVE_KEY_RE =
  /(?:^|\.|_)(?:secret|password|token|apikey|api_key|privatekey|private_key|mnemonic|credential|authorization|bearer|cookie|sessionkey|session_id)(?:\.|_|$)|^apikey$|_api_key$|_key$/i;

const MAX_DEPTH = 14;
const MAX_ARRAY = 40;
const MAX_STRING = 120;

/**
 * True when settings debug is enabled (Node: process.env; browser: import.meta.env from Vite define).
 */
export function isElizaSettingsDebugEnabled(options?: {
  /** Node / Bun process.env */
  env?: Record<string, string | undefined> | null;
  /** Vite `import.meta.env` (pass only in browser bundles). */
  importMetaEnv?: Record<string, unknown> | null;
}): boolean {
  const im = options?.importMetaEnv;
  if (im) {
    if (isTruthyEnvValue(String(im.ELIZA_SETTINGS_DEBUG ?? "").trim()))
      return true;
    if (isTruthyEnvValue(String(im.VITE_ELIZA_SETTINGS_DEBUG ?? "").trim()))
      return true;
  }
  const e = options?.env;
  if (e) {
    if (isTruthyEnvValue(e.ELIZA_SETTINGS_DEBUG)) return true;
    if (isTruthyEnvValue(e.VITE_ELIZA_SETTINGS_DEBUG)) return true;
  }
  if (typeof process !== "undefined" && process.env) {
    if (isTruthyEnvValue(process.env.ELIZA_SETTINGS_DEBUG)) return true;
    if (isTruthyEnvValue(process.env.VITE_ELIZA_SETTINGS_DEBUG)) return true;
  }
  return false;
}

function maskString(s: string): string {
  const t = s.trim();
  if (t.length <= 8) return "[redacted:short]";
  return `${t.slice(0, 4)}…${t.slice(-2)} (${t.length} chars)`;
}

function sanitizeDebugString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.toUpperCase() === "[REDACTED]") return "[REDACTED]";
  if (trimmed.length > 48 || /^(sk-|pk_|Bearer\s)/i.test(trimmed)) {
    return maskString(trimmed);
  }
  if (trimmed.length > MAX_STRING) return `${trimmed.slice(0, MAX_STRING)}…`;
  return trimmed;
}

function sanitizeDebugArray(
  value: unknown[],
  depth: number,
  seen: WeakSet<object>,
): unknown[] {
  const out: unknown[] = [];
  const cap = Math.min(value.length, MAX_ARRAY);
  for (let i = 0; i < cap; i++) {
    out.push(sanitizeForSettingsDebug(value[i], depth + 1, seen));
  }
  if (value.length > cap) {
    out.push(`… +${value.length - cap} more`);
  }
  return out;
}

function sanitizeSensitiveDebugValue(value: unknown): unknown {
  if (typeof value === "string" && value.trim()) return maskString(value);
  if (value == null || value === "") return value;
  return "[redacted]";
}

function sanitizeDebugObject(
  value: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key)
      ? sanitizeSensitiveDebugValue(item)
      : sanitizeForSettingsDebug(item, depth + 1, seen);
  }
  return out;
}

/**
 * Deep-clone-ish snapshot safe to log (secrets masked). Not for security boundaries — debug only.
 */
export function sanitizeForSettingsDebug(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeDebugString(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return `[fn ${value.name || "anonymous"}]`;
  if (typeof value !== "object") return String(value);

  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return sanitizeDebugArray(value, depth, seen);
  }

  return sanitizeDebugObject(value as Record<string, unknown>, depth, seen);
}

/** Compact cloud slice for logs (no raw secrets). */
export function settingsDebugCloudSummary(
  cloud: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!cloud || typeof cloud !== "object") return { cloud: null };
  const apiKey = cloud.apiKey;
  return {
    enabled: cloud.enabled,
    inferenceMode: cloud.inferenceMode,
    services: cloud.services,
    baseUrl: cloud.baseUrl,
    hasApiKey:
      typeof apiKey === "string" ? apiKey.trim().length > 0 : Boolean(apiKey),
  };
}
