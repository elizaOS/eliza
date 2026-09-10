/**
 * Opt-in verbose logging for settings load / change / save flows.
 * Enable with ELIZA_SETTINGS_DEBUG=1 (and Vite: same env at build time, or VITE_ELIZA_SETTINGS_DEBUG=1).
 */

import { resolveAliasedEnvValue } from "./boot-env.js";
import { isTruthyEnvValue } from "./env-utils.js";
import {
	tailWellFormed,
	toWellFormedUnicode,
	truncateWellFormed,
} from "./utils/well-formed";

/** Keys whose values are always redacted in debug dumps. */
const SENSITIVE_KEY_RE =
	/(?:^|\.|_)(?:secret|password|token|apikey|api_key|privatekey|private_key|mnemonic|credential|authorization|bearer|cookie|sessionkey|session_id)(?:\.|_|$)|^apikey$|_api_key$|_key$/i;

const MAX_DEPTH = 14;
/**
 * Ceiling on the nodes one snapshot may emit. A settings graph that reuses
 * one object from several keys is rendered once per path (the snapshot carries
 * no reference identity), which is exponential in the sharing depth even for a
 * handful of objects; past this many nodes every further value collapses to
 * "[max-size]" so a debug snapshot can never exhaust the process it is
 * diagnosing.
 */
const MAX_NODES = 20_000;

/** Per-walk emission counter threaded alongside `depth`. */
interface SnapshotBudget {
	remaining: number;
}
const MAX_ARRAY = 40;
export const MAX_STRING = 120;

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
		if (isTruthyEnvValue(resolveAliasedEnvValue("ELIZA_SETTINGS_DEBUG")))
			return true;
		if (isTruthyEnvValue(resolveAliasedEnvValue("VITE_ELIZA_SETTINGS_DEBUG")))
			return true;
	}
	return false;
}

function maskString(s: string): string {
	const wellFormed = toWellFormedUnicode(s.trim());
	if (wellFormed.length <= 8) return "[redacted:short]";
	const head = truncateWellFormed(wellFormed, 4);
	const tail = tailWellFormed(wellFormed, 2);
	return `${head}…${tail} (${wellFormed.length} chars)`;
}

export function sanitizeDebugString(value: string): string {
	const trimmed = toWellFormedUnicode(value.trim());
	if (trimmed.length === 0) return "";
	if (trimmed.toUpperCase() === "[REDACTED]") return "[REDACTED]";
	if (trimmed.length > 48 || /^(sk-|pk_|Bearer\s)/i.test(trimmed)) {
		return maskString(trimmed);
	}
	if (trimmed.length > MAX_STRING)
		return `${truncateWellFormed(trimmed, MAX_STRING - 1)}…`;
	return trimmed;
}

function sanitizeDebugArray(
	value: unknown[],
	depth: number,
	seen: WeakSet<object>,
	budget: SnapshotBudget,
): unknown[] {
	const out: unknown[] = [];
	const cap = Math.min(value.length, MAX_ARRAY);
	for (let i = 0; i < cap; i++) {
		out.push(sanitizeForSettingsDebug(value[i], depth + 1, seen, budget));
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
	budget: SnapshotBudget,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = SENSITIVE_KEY_RE.test(key)
			? sanitizeSensitiveDebugValue(item)
			: sanitizeForSettingsDebug(item, depth + 1, seen, budget);
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
	budget: SnapshotBudget = { remaining: MAX_NODES },
): unknown {
	if (depth > MAX_DEPTH) return "[max-depth]";
	// Every emitted node, this marker included, spends budget, so the
	// snapshot stays bounded however many paths reach the same object.
	if (budget.remaining <= 0) return "[max-size]";
	budget.remaining -= 1;
	if (value === null || value === undefined) return value;
	if (typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return sanitizeDebugString(value);
	if (typeof value === "bigint") return String(value);
	if (typeof value === "function") return `[fn ${value.name || "anonymous"}]`;
	if (typeof value !== "object") return String(value);

	// `seen` is the ancestor path of the value being sanitized, not every
	// object visited so far: a reference is circular only while its target is
	// still open above it. The entry is removed once the subtree is done, so a
	// settings graph that reuses one object from two places renders both in
	// full instead of collapsing the second one to "[circular]".
	if (seen.has(value as object)) return "[circular]";
	seen.add(value as object);
	try {
		if (Array.isArray(value)) {
			return sanitizeDebugArray(value, depth, seen, budget);
		}
		return sanitizeDebugObject(
			value as Record<string, unknown>,
			depth,
			seen,
			budget,
		);
	} finally {
		seen.delete(value as object);
	}
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
