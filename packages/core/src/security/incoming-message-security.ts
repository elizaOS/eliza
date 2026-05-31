/**
 * GHSA-gh63-5vpj-39qp — wire external-content defenses into the live message path.
 */

import type { IAgentRuntime } from "../types/runtime.ts";
import type { Memory } from "../types/memory.ts";
import type { PipelineHookSpec } from "../types/pipeline-hooks.ts";
import type { ContentValue } from "../types/primitives.ts";
import {
	detectSuspiciousPatterns,
	type ExternalContentSource,
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
};

function resolveExternalSource(source: string | undefined): ExternalContentSource {
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
	const existing = message.content.metadata;
	if (typeof existing === "object" && existing !== null) {
		return existing as IncomingMessageSecurityMetadata;
	}
	return {};
}

/**
 * Apply injection detection + external wrapping before compose / LLM.
 * Mutates `message.content` in place (pipeline hook + optional direct callers).
 */
export function hardenIncomingUserMessage(message: Memory): void {
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
		},
	};
	runtime.registerPipelineHook(spec);
}
