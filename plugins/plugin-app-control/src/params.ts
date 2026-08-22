/**
 * @module plugin-app-control/params
 * @description Extract the target app identifier from action options or the
 * triggering user message. Scoped narrowly on purpose — the upstream
 * `@elizaos/agent` package has a richer i18n keyword system; this plugin
 * only needs to pick a single token after verbs like "launch" / "close".
 */

import type { Memory } from "@elizaos/core";
import { getUserMessageText, unwrapUserMessageText } from "@elizaos/core";

const LAUNCH_VERBS = [
	"launch",
	"open",
	"start",
	"run",
	"fire up",
	"boot",
	"show",
];

const CLOSE_VERBS = [
	"close",
	"stop",
	"exit",
	"quit",
	"kill",
	"shut down",
	"shutdown",
	"terminate",
];

const FILLER_WORDS = new Set([
	"the",
	"app",
	"application",
	"overlay",
	"mini",
	"please",
	"now",
	"my",
]);

function extractAfterVerbs(
	text: string,
	verbs: readonly string[],
): string | null {
	const lower = text.toLowerCase();
	for (const verb of verbs) {
		const idx = lower.indexOf(verb);
		if (idx === -1) continue;
		const afterIdx = idx + verb.length;
		const rest = text.slice(afterIdx).trim();
		if (!rest) continue;

		const tokens = rest
			.split(/[\s,!.?]+/)
			.map((token) => token.trim())
			.filter((token) => token.length > 0);

		// Peel fillers off the front ("the", "app", etc.). Whatever remains
		// is the candidate name.
		let i = 0;
		while (i < tokens.length && FILLER_WORDS.has(tokens[i].toLowerCase())) {
			i += 1;
		}
		const candidate = tokens[i]?.toLowerCase();
		if (candidate && !FILLER_WORDS.has(candidate)) {
			return candidate;
		}
	}
	return null;
}

/**
 * The triggering message's actual words for target/query extraction. On
 * hardened connectors core wraps `content.text` in the external-content
 * security envelope, so a raw `content.text` fallback holds ~2KB of
 * scaffolding whose warning text even contains verbs ("change", …) the
 * substring extractors match on — and any echo of it shipped the entire
 * envelope to chat (live leak 2026-08-02, tj-2dc95f75456876). Unwrap the
 * security envelope first, then let getUserMessageText strip the
 * document-augmentation envelope and language-instruction suffix.
 */
export function userRequestMessageText(message: Memory | undefined): string {
	if (!message?.content) return "";
	return getUserMessageText({
		content: { ...message.content, text: unwrapUserMessageText(message) },
	});
}

/**
 * Render a user-supplied view target or search query for user-facing chat
 * text. Extraction can fall back to the whole message text and a planner can
 * hand any blob through an option, so a not-found/ambiguous echo must never
 * quote the value verbatim unless it is name-shaped. This is a shape
 * property, not content sniffing: real view names and search queries are
 * short single-line strings, a rendered prompt or envelope never is. A
 * name-shaped value (non-empty, single line, ≤64 chars) renders quoted;
 * anything else renders as the neutral `fallback` noun.
 */
export function describeTargetReference(
	reference: string,
	fallback = "that view",
): string {
	const trimmed = reference.trim();
	const nameShaped =
		trimmed.length > 0 && trimmed.length <= 64 && !/[\r\n]/.test(trimmed);
	return nameShaped ? `"${trimmed}"` : fallback;
}

/**
 * Render a complete target/query for machine-facing action text/data while
 * normalizing whitespace. Invalid shapes must be rejected at their owning
 * boundary rather than silently changing the value here.
 */
export function targetReferenceLogView(reference: string): string {
	const collapsed = reference.replace(/\s+/g, " ").trim();
	return collapsed;
}

export function normalizeActionOptions(
	options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!options) return undefined;
	const nested = options.parameters;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		return nested as Record<string, unknown>;
	}
	return options;
}

export function readStringOption(
	options: Record<string, unknown> | undefined,
	key: string,
): string | null {
	const normalized = normalizeActionOptions(options);
	if (!normalized) return null;
	const value = normalized[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

// Planner models emit stringified absent-values ("None", "null", "undefined")
// for OPTIONAL parameters they do not use. Only reference-style options
// (editTarget, runId, …) opt into this filter: a value like "none" is a
// legitimate literal for settings values, colors, and search queries, so the
// shared readStringOption must never swallow it.
const ABSENT_SENTINELS = new Set(["none", "null", "undefined"]);

export function readOptionalRefOption(
	options: Record<string, unknown> | undefined,
	key: string,
): string | null {
	const value = readStringOption(options, key);
	if (value && ABSENT_SENTINELS.has(value.toLowerCase())) return null;
	return value;
}

export function extractLaunchTarget(
	message: Memory | undefined,
	options: Record<string, unknown> | undefined,
): string | null {
	return (
		readStringOption(options, "app") ??
		readStringOption(options, "name") ??
		extractAfterVerbs(userRequestMessageText(message), LAUNCH_VERBS)
	);
}

export function extractCloseTarget(
	message: Memory | undefined,
	options: Record<string, unknown> | undefined,
): { runId: string | null; appName: string | null } {
	const runId = readStringOption(options, "runId");
	const appName =
		readStringOption(options, "app") ??
		readStringOption(options, "name") ??
		extractAfterVerbs(userRequestMessageText(message), CLOSE_VERBS);
	return { runId, appName };
}
