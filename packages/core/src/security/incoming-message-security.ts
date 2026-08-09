/**
 * GHSA-gh63-5vpj-39qp — wire external-content defenses into the live message path.
 */

import type { Memory } from "../types/memory.ts";
import type { PipelineHookSpec } from "../types/pipeline-hooks.ts";
import type { ContentValue } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	containsExternalEnvelopeMaterial,
	detectSuspiciousPatterns,
	type ExternalContentSource,
	extractWrappedExternalContent,
	wrapExternalContent,
} from "./external-content.js";
import { redactSensitiveText } from "./redact.js";

const PUBLIC_CHANNEL_SOURCES = new Set([
	"discord",
	"telegram",
	"twitter",
	"slack",
	"whatsapp",
	"bluebubbles",
	"imessage",
	"sms",
	"webhook",
	"api",
]);

const FINANCIAL_COMMAND_PATTERNS = [
	/\bsend\s+\d+(?:\.\d+)?\s+(?:sol|eth|usdc|usdt|btc)\b/i,
	/\btransfer\s+\d+(?:\.\d+)?\s+(?:sol|eth|usdc|usdt)\b/i,
	/\btransfer\s+(?:all|everything|max)\b/i,
	/\bswap\s+all\b/i,
];

export type IncomingMessageSecurityMetadata = {
	promptInjectionSuspected?: boolean;
	promptInjectionPatterns?: string[];
	externalContentWrapped?: boolean;
	/**
	 * The user's exact words, retained at the inbound trust boundary BEFORE the
	 * external-content envelope replaces `content.text`. The envelope exists for
	 * prompts (the model must see the untrusted-content warning); every
	 * non-prompt consumer — resolvers, query fallbacks, anything echoed back to
	 * chat — reads this field through `unwrapUserMessageText` and never parses
	 * the armor back out of the prompt text. Persisted with the message content,
	 * so replayed/stored messages keep the trusted payload. Only
	 * `hardenIncomingUserMessage` may stamp it; forged inbound values are
	 * stripped there like the autonomy marker. The pipeline hook applies
	 * `scrubIncomingMessageTextForStorage` to this field exactly as it does to
	 * `content.text` — the retained copy persists and gets echoed by payload
	 * consumers, so an unscrubbed copy would resurrect every secret the text
	 * scrub removed.
	 */
	userPayloadText?: string;
};

/**
 * The message `source` the autonomy service stamps on its own self-prompts
 * (packages/core/src/features/autonomy/service.ts). It is the only legitimate
 * producer of the `isAutonomous` marker; keep the two in sync.
 */
const AUTONOMY_INTERNAL_SOURCE = "autonomy-service";

/**
 * #12087 Item 7: `content.metadata.isAutonomous` is a runtime-internal marker
 * that unlocks private (autonomy-only) actions via the private-action gate. Only
 * the autonomy service should set it, on messages sourced `AUTONOMY_INTERNAL_SOURCE`.
 * A connector that forwards client-supplied `content.metadata` would otherwise let
 * an external user set it and run private actions. Strip it from every inbound
 * message that is not a genuine autonomy dispatch. `source` is connector-set (not
 * carried in client-forwarded metadata), so it is the reliable discriminator.
 */
function stripUntrustedAutonomyMarker(message: Memory): void {
	const metadata = message.content.metadata;
	if (typeof metadata !== "object" || metadata === null) {
		return;
	}
	const source =
		typeof message.content.source === "string" ? message.content.source : "";
	if (source === AUTONOMY_INTERNAL_SOURCE) {
		return;
	}
	if ("isAutonomous" in metadata) {
		delete (metadata as Record<string, unknown>).isAutonomous;
	}
}

function resolveExternalSource(
	source: string | undefined,
): ExternalContentSource {
	const normalized = (source ?? "").trim().toLowerCase();
	if (normalized.includes("discord")) return "api";
	if (normalized.includes("telegram")) return "api";
	if (normalized.includes("webhook")) return "webhook";
	if (PUBLIC_CHANNEL_SOURCES.has(normalized)) {
		return normalized === "webhook" ? "webhook" : "api";
	}
	return "unknown";
}

function shouldTreatSourceAsUntrusted(source: string | undefined): boolean {
	if (!source) return true;
	const normalized = source.trim().toLowerCase();
	if (normalized === "autonomy" || normalized === "internal") return false;
	if (normalized === "messageservice" || normalized === "test") return false;
	return (
		PUBLIC_CHANNEL_SOURCES.has(normalized) ||
		normalized.includes("discord") ||
		normalized.includes("telegram") ||
		normalized.includes("twitter")
	);
}

function hasFinancialCommandLanguage(text: string): boolean {
	return FINANCIAL_COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

function readMessageMetadata(message: Memory): IncomingMessageSecurityMetadata {
	// Optional-chained: `unwrapUserMessageText` accepts loosely-shaped messages
	// from evaluator/routing contexts where `content` may be absent.
	const existing = message.content?.metadata;
	if (typeof existing === "object" && existing !== null) {
		return existing as IncomingMessageSecurityMetadata;
	}
	return {};
}

/**
 * Security metadata is runtime-owned. A connector that forwards
 * client-supplied `content.metadata` must not pre-stamp a payload different
 * from the visible text, fabricate an injection result, or pre-populate an
 * adjudication cache entry. Same doctrine as the forged autonomy marker:
 * strip every internal security stamp before hardening recomputes its own.
 */
function stripForgedSecurityStamps(message: Memory): void {
	const metadata = message.content.metadata;
	if (typeof metadata !== "object" || metadata === null) {
		return;
	}
	const record = metadata as Record<string, unknown>;
	if ("userPayloadText" in record) {
		delete record.userPayloadText;
	}
	if ("externalContentWrapped" in record) {
		delete record.externalContentWrapped;
	}
	if ("promptInjectionSuspected" in record) {
		delete record.promptInjectionSuspected;
	}
	if ("promptInjectionPatterns" in record) {
		delete record.promptInjectionPatterns;
	}
	if ("injectionRisk" in record) {
		delete record.injectionRisk;
	}
	if ("injectionRiskAdjudication" in record) {
		delete record.injectionRiskAdjudication;
	}
}

/**
 * Apply injection detection + external wrapping at the inbound trust boundary,
 * before compose / LLM. Mutates `message.content` in place (pipeline hook +
 * optional direct callers). For untrusted sources the user's exact words are
 * retained in `metadata.userPayloadText` and `content.text` becomes the
 * security envelope: prompts read the envelope, everything else reads the
 * retained payload via `unwrapUserMessageText`.
 */
export function hardenIncomingUserMessage(message: Memory): void {
	// Runs before the empty-text guard: an external message must never keep a
	// forged autonomy marker or forged security stamps regardless of its text
	// (#12087 Item 7).
	stripUntrustedAutonomyMarker(message);
	stripForgedSecurityStamps(message);

	const text =
		typeof message.content.text === "string" ? message.content.text : "";
	if (!text.trim()) {
		return;
	}

	const source =
		typeof message.content.source === "string"
			? message.content.source
			: undefined;
	const metadata = readMessageMetadata(message);
	const matches = detectSuspiciousPatterns(text);
	const financialLanguage = hasFinancialCommandLanguage(text);

	if (matches.length > 0 || financialLanguage) {
		metadata.promptInjectionSuspected = true;
		metadata.promptInjectionPatterns = matches;
	}

	if (shouldTreatSourceAsUntrusted(source)) {
		metadata.userPayloadText = text;
		message.content.text = wrapExternalContent(text, {
			source: resolveExternalSource(source),
			includeWarning: true,
		});
		metadata.externalContentWrapped = true;
	}

	message.content.metadata = metadata as { [key: string]: ContentValue };
}

/** Redact secret-shaped substrings before persisting user text to memory. */
export function scrubIncomingMessageTextForStorage(text: string): string {
	return redactSensitiveText(text, { mode: "tools" });
}

/**
 * Canonical accessor for the user's actual words from a message that
 * `hardenIncomingUserMessage` may have wrapped in the external-content
 * security envelope. The envelope exists for PROMPTS — the model must see the
 * untrusted-content warning — but code that treats `content.text` as user
 * input (query fallbacks, name/target extraction, anything later echoed back
 * to chat) must operate on the payload, not the armor: an action that quoted
 * the raw text shipped the entire envelope to Discord (live leak 2026-08-02,
 * tj-2dc95f75456876), and a resolver that matched on it selected apps by
 * warning words.
 *
 * Resolution order: the retained `metadata.userPayloadText` stamp when present
 * (the trusted copy taken before wrapping); otherwise, ONLY when the
 * `externalContentWrapped` stamp attests the envelope came from this module, a
 * marker parse of `content.text` (legacy messages persisted before the
 * retained field existed); otherwise the raw text. Unstamped marker-shaped
 * text is never parsed — the stamp is the authenticity proof, and extracting a
 * "payload" from an unauthenticated envelope would let injected marker text
 * place attacker-chosen words (e.g. a "yes" for a destructive confirm) where
 * consumers read the user's words. Whatever wins is validated last: a result
 * that still reads as envelope material (partial markers, the warning
 * sentence, a stamped message whose markers were mangled, unstamped armor)
 * returns "" — an empty reference sends resolvers down their ask-the-user path
 * instead of matching warning words, which is the only safe interpretation of
 * armor debris.
 */
export function unwrapUserMessageText(message: Memory): string {
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	const metadata = readMessageMetadata(message);
	const retained = metadata.userPayloadText;
	let candidate: string;
	if (typeof retained === "string" && retained.trim().length > 0) {
		candidate = retained;
	} else if (metadata.externalContentWrapped === true) {
		candidate = extractWrappedExternalContent(text) ?? text;
	} else {
		candidate = text;
	}
	const trimmed = candidate.trim();
	return containsExternalEnvelopeMaterial(trimmed) ? "" : trimmed;
}

export function messageHasPromptInjectionFlag(message: Memory): boolean {
	const metadata = readMessageMetadata(message);
	return metadata.promptInjectionSuspected === true;
}

export function registerCoreIncomingMessageSecurityHook(
	runtime: IAgentRuntime,
): void {
	const spec: PipelineHookSpec = {
		id: "core:incoming-message-security",
		phase: "incoming_before_compose",
		position: 5,
		mutatesPrimary: true,
		handler: (_runtime, ctx) => {
			if (ctx.phase !== "incoming_before_compose") {
				return;
			}
			hardenIncomingUserMessage(ctx.message);
			const text =
				typeof ctx.message.content.text === "string"
					? ctx.message.content.text
					: "";
			if (text) {
				ctx.message.content.text = scrubIncomingMessageTextForStorage(text);
			}
			// The retained payload persists to memory alongside content.text and is
			// what unwrapUserMessageText prefers, so it must pass through the same
			// storage scrub — otherwise a pasted secret the text scrub removed
			// survives in metadata and re-echoes through every payload consumer.
			const metadata = ctx.message.content.metadata;
			if (typeof metadata === "object" && metadata !== null) {
				const record = metadata as Record<string, unknown>;
				if (
					typeof record.userPayloadText === "string" &&
					record.userPayloadText
				) {
					record.userPayloadText = scrubIncomingMessageTextForStorage(
						record.userPayloadText,
					);
				}
			}
		},
	};
	runtime.registerPipelineHook(spec);
}
