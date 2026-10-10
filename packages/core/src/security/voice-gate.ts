import { ElizaError } from "../errors";
import { readReminderPresentation } from "../types/reminder-presentation";
/**
 * The humanness voice gate: the single canonical last-mile pass that
 * rewrites any outbound literal into the agent's own natural voice before it
 * reaches a user, so a user never sees a hardcoded template, a canned status
 * string, or a raw `error.message`. The owner directive is absolute — "we
 * always want response messages to the user to be as if a real person
 * responded to them, no hardcoded messages or injections, even errors should
 * be rephrased."
 *
 * There is no single byte-level chokepoint: agent text leaves through two
 * transports (connector send vs in-app WebSocket) plus notifications. So "one
 * seam" is one gate implementation mandated at each transport boundary, not one
 * literal function call — {@link ensureAgentVoice} is invoked at
 * `AgentRuntime.sendMessageToTarget` (every connector-delivered agent message)
 * and at the in-app proactive relay. It is gated by the `agentVoiced`
 * provenance flag: text that is already the agent's composed voice (a
 * model-generated reply, or output this gate already rephrased) passes through
 * untouched, so genuine model output is never double-voiced and its exact
 * values are never disturbed.
 *
 * Same model seam as the scheduled-dispatch renderer and the failure-reply
 * path — `runWithTrajectoryPurpose` + `runtime.useModel` — but on ModelType
 * TEXT_SMALL with a per-agent input-hash cache, because this runs on every
 * outbound literal and must stay cheap. It diverges from the dispatch
 * renderer's fail-fast in one deliberate way (V1 below): the gate is a cosmetic
 * pass over already-final text, so a rephrase failure delivers the ORIGINAL
 * text unchanged and reports the error, never blocking delivery — dropping a
 * real user message is strictly worse than delivering one raw literal once with
 * the outage flagged.
 */

import { runWithTrajectoryPurpose } from "../trajectory-context.ts";
import { readActionReplyFailure } from "../types/action-reply.ts";
import { ModelType } from "../types/model.ts";
import type { Content } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { readSystemNotice, systemNoticeText } from "../types/system-notice.ts";
import { stripReasoningBlocks } from "./model-failure.ts";

export interface EnsureAgentVoiceOptions {
	/** Origin of the outbound text (connector source, `autonomy`, `escalation`,
	 * …). Part of the cache key and the reportError context so the same literal
	 * from two surfaces rephrases independently. */
	source: string;
}

/**
 * Bounded LRU of already-rephrased text keyed by `agentId\0source\0hash(raw)`.
 * A repeated literal (the same connector-down error, the same escalation
 * template) rephrases once and is served from cache thereafter, so the gate
 * adds a TEXT_SMALL round-trip only on first sight of each distinct string.
 */
const VOICE_CACHE_MAX = 500;
const voiceCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
	const hit = voiceCache.get(key);
	if (hit === undefined) return undefined;
	// Re-insert to mark most-recently-used (Map preserves insertion order).
	voiceCache.delete(key);
	voiceCache.set(key, hit);
	return hit;
}

function cacheSet(key: string, value: string): void {
	voiceCache.set(key, value);
	if (voiceCache.size > VOICE_CACHE_MAX) {
		const oldest = voiceCache.keys().next().value;
		if (oldest !== undefined) voiceCache.delete(oldest);
	}
}

/** Non-cryptographic FNV-1a string hash. A cache key only needs low collision
 * probability, not cryptographic strength, and this keeps the module free of
 * `node:crypto` so it stays safe in the browser/edge core bundles. */
function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

function joinLines(...parts: (string | undefined | false)[]): string {
	return parts.filter((p): p is string => typeof p === "string").join("\n");
}

/**
 * Build the rephrase prompt from the character persona and the raw text. Reuses
 * the failure-reply hard-rules skeleton: no internal-mechanism words, no
 * em-dashes, preserve every exact value verbatim, return only the reply text.
 * Exported for direct unit testing of prompt content.
 *
 * The complete bio and voice/style directive lists are included, never an
 * item-count cap: a dropped directive (for example a language or formality
 * rule) would silently rewrite this literal against a persona the owner never
 * configured. Only non-string and blank entries are filtered out.
 */
export function buildVoiceGatePrompt(
	character: IAgentRuntime["character"],
	rawText: string,
): string {
	const name = character?.name?.trim() || "the assistant";
	const bio = Array.isArray(character?.bio)
		? character.bio.filter((b) => typeof b === "string" && b.trim())
		: [];
	const style = [
		...(character?.style?.all ?? []),
		...(character?.style?.chat ?? []),
	].filter((s) => typeof s === "string" && s.trim());

	return joinLines(
		`You are ${name}. Rewrite the message below so it reads as if you, a real person, wrote it yourself in your own natural voice. It must sound human, never like a canned system string.`,
		bio.length > 0 && "",
		bio.length > 0 && "About you:",
		...bio.map((b) => `- ${b}`),
		style.length > 0 && "",
		style.length > 0 && "Your voice and tone:",
		...style.map((s) => `- ${s}`),
		"",
		"Hard rules:",
		"- Preserve every exact value verbatim: numbers, counts, prices, amounts, dates, times, file paths, IDs, URLs, code, commands, and proper names must appear unchanged.",
		"- Do not add any new information, do not answer anything the message does not already answer, and do not drop any concrete fact the message states.",
		"- If the message reports a problem or error, keep it an honest, plain acknowledgement that something went wrong. Do not invent a cause and do not pretend it succeeded.",
		"- Never mention internal mechanism words such as: planner, action, handler, callback, JSON, XML, schema, model, prompt, parser, runtime, dispatch, connector, promptInstructions, null, undefined, stack trace, or exception. The user does not know or care what those are.",
		"- Do not use em-dashes or en-dashes. Use a plain hyphen, period, or comma.",
		"- Keep it roughly the same length as the original.",
		"- Return ONLY the rewritten message text. No labels, no surrounding quotes, no markdown fences, no <think>.",
		"",
		"Message to rewrite:",
		rawText,
		"",
		"Rewritten message:",
	);
}

/**
 * Rewrite `content.text` into the agent's natural voice unless it is already
 * voiced or empty. Returns a new `Content` with `agentVoiced: true` on success;
 * on any failure (thrown model call, blank output, no model surface) returns
 * the ORIGINAL content unchanged after `runtime.reportError` — delivery is
 * never blocked. Non-text content (attachments only, no `text`) passes through.
 */
export async function ensureAgentVoice(
	runtime: IAgentRuntime,
	content: Content,
	options: EnsureAgentVoiceOptions,
): Promise<Content> {
	// This is a system status explicitly stating that no model reply exists.
	// Re-voicing it would retry the failed generation and falsely grant prose
	// provenance; preserve its typed failure marker without agentVoiced=true.
	if (
		content.elizaSyntheticFailure === true &&
		readActionReplyFailure(content.replyFailure)
	)
		return content;
	if (content.reminderPresentation !== undefined) {
		const reminder = readReminderPresentation(content.reminderPresentation);
		if (!reminder || content.text !== reminder.chatText)
			throw new ElizaError("Untrusted or mismatched reminder presentation", {
				code: "REMINDER_PRESENTATION_UNTRUSTED",
			});
		const {
			agentVoiced: _voice,
			reminderPresentation: _authority,
			...rest
		} = content;
		return { ...rest, text: reminder.chatText };
	}
	const notice = readSystemNotice(content.systemNotice);
	if (notice) {
		const { agentVoiced: _provenance, ...status } = content;
		return {
			...status,
			text: systemNoticeText(notice, runtime.character.name),
		};
	}
	const rewriteOverride = runtime.getSetting?.("OUTBOUND_VOICE_REWRITE");
	if (
		rewriteOverride !== undefined &&
		rewriteOverride !== null &&
		["false", "0", "no", "off"].includes(
			String(rewriteOverride).trim().toLowerCase(),
		)
	) {
		return content;
	}
	const raw = typeof content.text === "string" ? content.text : "";
	if (raw.trim().length === 0) return content;
	if (content.agentVoiced === true) return content;
	if (typeof runtime.useModel !== "function") return content;

	const key = `${runtime.agentId}\u0000${options.source}\u0000${hashText(raw)}`;
	const cached = cacheGet(key);
	if (cached !== undefined) {
		return { ...content, text: cached, agentVoiced: true };
	}

	const escalationDiagnostic =
		content.metadata !== null &&
		typeof content.metadata === "object" &&
		"escalation" in content.metadata &&
		content.metadata.escalation === true;
	let rephrased = "";
	try {
		const prompt = buildVoiceGatePrompt(runtime.character, raw);
		const response = await runWithTrajectoryPurpose("voice-gate-rephrase", () =>
			runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
		);
		rephrased =
			typeof response === "string" ? stripReasoningBlocks(response).trim() : "";
	} catch (error) {
		// error-policy:J4 voice-policy:V1 fail-open. The gate is a cosmetic last-mile pass over
		// already-final text; blocking would drop a real user message, which is
		// strictly worse than delivering the raw literal once with the outage
		// surfaced to the agent/owner via reportError.
		runtime.reportError("voice-gate", error, {
			source: options.source,
			agentId: runtime.agentId,
			...(escalationDiagnostic ? { diagnosticOnly: true } : {}),
		});
		return content;
	}

	if (rephrased.length === 0) {
		// voice-policy:V1 blank model output is a failure, not a valid rewrite —
		// deliver the original rather than an empty message.
		runtime.reportError(
			"voice-gate",
			new Error("voice-gate rephrase returned empty output"),
			{
				source: options.source,
				agentId: runtime.agentId,
				...(escalationDiagnostic ? { diagnosticOnly: true } : {}),
			},
		);
		return content;
	}

	cacheSet(key, rephrased);
	return { ...content, text: rephrased, agentVoiced: true };
}
