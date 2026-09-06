/** Wraps visible message callbacks with shared voice rendering, duplicate-delivery suppression, and egress policy. */

import { v4 } from "uuid";
import { getEffectDeliveryBinding } from "../../runtime/effect-delivery";
import { containsExternalEnvelopeMaterial } from "../../security/external-content";
import {
	guardOutboundEnvelopeAttachments,
	guardOutboundEnvelopeText,
	reportOutboundEnvelopeBlock,
} from "../../security/outbound-envelope-guard";
import type { HandlerCallback } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { GenerateTextResult, TextToSpeechParams } from "../../types/model";
import { ModelType } from "../../types/model";
import type { Content } from "../../types/primitives";
import { ContentType } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { parseBooleanFromText, parseJSONObjectFromText } from "../../utils";
import { isObjectRecord as isRecord } from "../../utils/type-guards";
import { PASSIVE_TURN_ACTIONS } from "./action-ownership.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";
import {
	enforceEffectGroundedVisibleContent,
	enforceTrustedDeliveryAudienceAtEgress,
} from "./egress-policy.js";
import { stripReasoningBlocks } from "./fallback-reply";
import { getV5ModelText } from "./generate-text-result";
import { sanitizeOutboundText } from "./outbound-sanitize";

export const INTERMEDIATE_CALLBACK_METADATA_KEYS = new Set([
	"actions",
	"agentVoiced",
	"channelType",
	"effectReceiptIds",
	"inReplyTo",
	"mentionContext",
	"merge",
	"providers",
	"reactedMessageText",
	"responseId",
	"responseMessageId",
	"source",
	"target",
	"thought",
	"transcriptVisibility",
]);

export function hasIntermediateCallbackPayload(content: Content): boolean {
	return Object.entries(content).some(([key, value]) => {
		if (key === "text" || INTERMEDIATE_CALLBACK_METADATA_KEYS.has(key)) {
			return false;
		}
		if (value === undefined || value === null) return false;
		if (typeof value === "string") return value.trim().length > 0;
		if (Array.isArray(value)) return value.length > 0;
		if (typeof value === "object") return Object.keys(value).length > 0;
		return true;
	});
}

export function withoutIntermediateVisibleText(
	content: Content,
): Content | null {
	const filtered = { ...content };
	delete filtered.text;
	return hasIntermediateCallbackPayload(filtered) ? filtered : null;
}

/**
 * Builds provider-neutral TTS input from character settings.
 *
 * Only `voiceId` is a provider voice identifier. The historical `model`
 * field contains Piper voice tags and `url` contains an endpoint, so forwarding
 * either as `voice` breaks OpenAI and cloud provider selection. Omitting
 * `voice` lets the active provider apply its own valid default.
 */
export function buildTextToSpeechParams(
	runtime: Pick<IAgentRuntime, "character">,
	text: string,
	signal?: AbortSignal,
): TextToSpeechParams {
	const voiceSettings = runtime.character.settings?.voice as
		| { voiceId?: string }
		| undefined;
	const voiceId = voiceSettings?.voiceId?.trim();
	return {
		text,
		...(voiceId ? { voice: voiceId } : {}),
		...(signal ? { signal } : {}),
	};
}

/**
 * First-sentence cloud-TTS delivery for streaming turns: synthesize the
 * sentence and hand the audio to the callback as a data-URI attachment. The
 * local-inference voice loop uses VoiceScheduler/PhraseChunker instead
 * (packages/app-core/src/services/local-inference/voice/scheduler.ts) — this
 * is not duplicated, it's the cloud-deployment counterpart (packages/core
 * can't import packages/app-core; the two paths live at different layers and
 * only one is active per deployment).
 *
 * Guarded before synthesis: for an envelope echo the "first sentence" IS the
 * security-notice line, and this delivery bypasses the text-only outbound
 * guard entirely (callback text is "", the armor rides in attachment.text and
 * the synthesized audio). Envelope material is never spoken or attached —
 * the delivery is skipped and reported instead. Exported for tests: the
 * stream closure it serves is only reachable through a full handleMessage
 * turn.
 */
export async function deliverFirstSentenceVoice(
	runtime: Pick<
		IAgentRuntime,
		"character" | "getModel" | "useModel" | "logger" | "reportError"
	>,
	first: string,
	callback: HandlerCallback | undefined,
	abortSignal?: AbortSignal,
): Promise<void> {
	if (containsExternalEnvelopeMaterial(first)) {
		reportOutboundEnvelopeBlock(runtime, first, "stream-tts");
		return;
	}
	try {
		let audioBuffer: Buffer | null = null;
		const params = buildTextToSpeechParams(runtime, first, abortSignal);
		const result = runtime.getModel(ModelType.TEXT_TO_SPEECH)
			? await runtime.useModel(ModelType.TEXT_TO_SPEECH, params)
			: undefined;

		if (
			result instanceof ArrayBuffer ||
			Object.prototype.toString.call(result) === "[object ArrayBuffer]"
		) {
			audioBuffer = Buffer.from(result as ArrayBuffer);
		} else if (Buffer.isBuffer(result)) {
			audioBuffer = result;
		} else if (result instanceof Uint8Array) {
			audioBuffer = Buffer.from(result);
		}

		if (audioBuffer && callback) {
			const audioBase64 = audioBuffer.toString("base64");
			await callback({
				text: "",
				attachments: [
					{
						id: v4(),
						url: `data:audio/wav;base64,${audioBase64}`,
						title: "Voice Response",
						source: "voice-cache",
						description: "Voice response for first sentence",
						text: first,
						contentType: ContentType.AUDIO,
					},
				],
				source: "voice",
			});
		}
	} catch (error) {
		// error-policy:J4 voice is an optional enhancement of a streamed turn;
		// a failed synthesis logs and the guarded text reply still delivers.
		runtime.logger.error(
			{ error },
			"Error generating voice for first sentence",
		);
	}
}

export function wrapSingleTurnVisibleCallback(
	// reportError is required: the fail-closed envelope guard inside `deliver`
	// must be able to surface a blocked leak even from partial test runtimes.
	runtime: Pick<IAgentRuntime, "agentId" | "logger" | "reportError"> &
		Partial<Pick<IAgentRuntime, "character" | "useModel">> & {
			getService?: IAgentRuntime["getService"];
		},
	message: Pick<Memory, "id" | "roomId" | "entityId">,
	callback?: HandlerCallback,
	recordDeliveredVisibleText?: (text: string) => void,
): HandlerCallback | undefined {
	if (!callback) return callback;
	const fullRuntime = runtime as IAgentRuntime;
	// Turn-scoped paraphrase suppression: a relay turn can REPLY, run another
	// tool, then REPLY again with a light rewording of the same completion
	// ("added an Install section … (15 lines added)." then "added an
	// **Install** section … (15 insertions)." — live 2026-08-18, double
	// message in the channel). Exact-dupe recording already exists downstream;
	// this catches the paraphrase class at the one funnel every visible
	// delivery passes through. Guarded tightly — ≥8 shared-vocabulary tokens
	// and ≥0.85 Jaccard — so progress updates that differ in the numbers or
	// content keep flowing.
	const deliveredTokenSetsThisTurn: Array<Set<string>> = [];
	const nearDuplicateOfDeliveredThisTurn = (text: string): boolean => {
		const tokens = new Set(
			text
				.toLowerCase()
				.replace(/[*_`~#>]+/g, " ")
				.split(/[^a-z0-9%.]+/)
				.filter((token) => token.length > 0),
		);
		if (tokens.size < 8) return false;
		for (const prior of deliveredTokenSetsThisTurn) {
			if (prior.size < 8) continue;
			let shared = 0;
			for (const token of tokens) if (prior.has(token)) shared++;
			const union = prior.size + tokens.size - shared;
			if (union > 0 && shared / union >= 0.85) return true;
		}
		return false;
	};
	const deliver = async (response: Content, actionName?: string) => {
		const fullMessage = message as Memory;
		response = await enforceTrustedDeliveryAudienceAtEgress(
			fullRuntime,
			fullMessage,
			response,
		);
		if (isRecord(response.data) && response.data.privacyDenied === true) {
			actionName = "PRIVACY_DENIED";
		}
		if (response.transcriptVisibility === "internal") {
			return [];
		}
		let rawUnsanitizedText: string | undefined;
		// Shared post-model, pre-channel sanitization (#15888): every visible
		// delivery — action callbacks, early replies, simple replies, terminal
		// content — funnels through this wrap, so stripping leaked machine
		// syntax here covers every connector without per-connector copies. The
		// envelope guard then fail-closed blocks any security-envelope echo the
		// model produced, replacing it with the honest leak notice.
		if (typeof response?.text === "string" && response.text.length > 0) {
			const guarded = guardOutboundEnvelopeText(
				fullRuntime,
				sanitizeOutboundText(response.text),
				"visible-callback",
			);
			if (guarded !== response.text) {
				// Record the raw form too: planner-echo suppression compares the
				// planner's unsanitized finalMessage against this set, and must
				// still recognize a delivery whose wire text was sanitized.
				rawUnsanitizedText = response.text.trim() ? response.text : undefined;
				response = { ...response, text: guarded };
			}
		}
		// Attachments are a delivery surface the text guard never sees: both
		// voice paths ship the spoken sentence as attachment.text under an empty
		// top-level text, so envelope material must be blocked here too.
		if (
			Array.isArray(response.attachments) &&
			response.attachments.length > 0
		) {
			const guardedAttachments = guardOutboundEnvelopeAttachments(
				fullRuntime,
				response.attachments,
				"visible-callback-attachment",
			);
			if (guardedAttachments !== response.attachments) {
				response = { ...response, attachments: guardedAttachments };
				// When the blocked attachment was the whole payload there is
				// nothing honest left to send — skip the delivery instead of
				// handing connectors an empty message.
				if (
					guardedAttachments.length === 0 &&
					!(typeof response.text === "string" && response.text.trim())
				) {
					return [];
				}
			}
		}
		response = enforceEffectGroundedVisibleContent(
			fullRuntime,
			response,
			actionName,
		);
		if (typeof response?.text === "string" && response.text.trim()) {
			if (nearDuplicateOfDeliveredThisTurn(response.text)) {
				fullRuntime.logger?.debug?.(
					{ actionName, text: response.text.slice(0, 120) },
					"[message] suppressed near-duplicate delivery within the turn",
				);
				recordDeliveredVisibleText?.(response.text);
				return [];
			}
			deliveredTokenSetsThisTurn.push(
				new Set(
					response.text
						.toLowerCase()
						.replace(/[*_`~#>]+/g, " ")
						.split(/[^a-z0-9%.]+/)
						.filter((token) => token.length > 0),
				),
			);
		}
		const delivered = await callback(response, actionName);
		if (rawUnsanitizedText) {
			recordDeliveredVisibleText?.(rawUnsanitizedText);
		}
		if (typeof response?.text === "string" && response.text.trim()) {
			recordDeliveredVisibleText?.(response.text);
		}
		// The voice rewrite (voiceActionReply below) restyles the wire text and
		// stashes the action's original text in data.rawActionText. The planner's
		// finalMessage is composed from that RAW text (a verified tool's
		// userFacingText), so record it too — same rationale as the sanitize-drift
		// recording above: echo suppression must recognize a delivery whose wire
		// form diverged from the text the planner re-selects.
		if (response?.data && typeof response.data === "object") {
			const rawActionText = (response.data as Record<string, unknown>)
				.rawActionText;
			if (typeof rawActionText === "string" && rawActionText.trim()) {
				recordDeliveredVisibleText?.(rawActionText);
			}
		}
		return delivered;
	};
	// The character-voice rewrite spends a TEXT_SMALL call per action callback and
	// restyles the delivered text. Deterministic harnesses (the scenario runner)
	// assert the raw action-callback contract and strict-fixture every model call,
	// so they opt out via ACTION_CALLBACK_VOICE_REWRITE=false; production turns
	// leave it on by default.
	if (!actionCallbackVoiceRewriteEnabled(fullRuntime)) return deliver;
	const voiceActionReply = async (
		response: Content,
		actionName?: string,
	): Promise<Content> => {
		if (response.transcriptVisibility === "internal") {
			return response;
		}
		if (!shouldRewriteActionCallback(response, actionName)) {
			return response;
		}
		const text = response.text?.trim();
		if (!text) return response;
		const rewritten = await rewriteActionCallbackInCharacter({
			runtime: fullRuntime,
			message,
			response,
			actionName: resolveCallbackActionName(response, actionName),
			text,
		});
		return rewritten && rewritten !== text
			? {
					...response,
					text: rewritten,
					data:
						response.data && typeof response.data === "object"
							? {
									...(response.data as Record<string, unknown>),
									rawActionText: text,
									voiceRewritten: true,
								}
							: {
									rawActionText: text,
									voiceRewritten: true,
								},
				}
			: response;
	};

	return async (response, actionName) =>
		deliver(await voiceActionReply(response, actionName), actionName);
}

export function resolveCallbackActionName(
	response: Content,
	actionName?: string,
): string | undefined {
	if (typeof actionName === "string" && actionName.trim()) {
		return actionName.trim();
	}
	const action = response.action;
	if (typeof action === "string" && action.trim()) {
		return action.trim();
	}
	const actions = response.actions;
	if (Array.isArray(actions)) {
		return actions.find((candidate) => candidate.trim().length > 0)?.trim();
	}
	return undefined;
}

export function actionCallbackVoiceRewriteEnabled(
	runtime: IAgentRuntime,
): boolean {
	if (typeof runtime.getSetting !== "function") return true;
	const raw = runtime.getSetting("ACTION_CALLBACK_VOICE_REWRITE");
	if (raw === undefined || raw === null) return true;
	const normalized = String(raw).trim();
	if (!normalized) return true;
	return parseBooleanFromText(normalized);
}

export function shouldRewriteActionCallback(
	response: Content | null | undefined,
	actionName?: string,
): response is Content & { text: string } {
	if (!response || typeof response.text !== "string") return false;
	// The settlement boundary marks only a byte-exact canonical action reply.
	// Re-voicing it would violate verifiedUserFacing's do-not-paraphrase contract.
	if (response.agentVoiced === true) return false;
	if (getEffectDeliveryBinding(response)) {
		return false;
	}
	if (!response.text.trim() && !response.attachments?.length) return false;
	// Media actions already produced a file attachment; deliver it directly instead
	// of spending another model call rewriting placeholder text.
	if (response.attachments?.some((media) => Boolean(media?.url))) return false;
	if (!response.text.trim()) return false;
	if (response.source === "voice") return false;
	if (response.source === "voice-cache") return false;
	const resolvedAction = normalizeActionIdentifier(
		resolveCallbackActionName(response, actionName) ?? "",
	);
	if (!resolvedAction) return false;
	return !PASSIVE_TURN_ACTIONS.has(resolvedAction);
}

export async function rewriteActionCallbackInCharacter(args: {
	runtime: IAgentRuntime;
	message: Pick<Memory, "id" | "roomId" | "entityId">;
	response: Content;
	actionName?: string;
	text: string;
}): Promise<string | null> {
	// Failure contract: a failed rewrite must never fabricate wire text — no
	// meta-narration about formatting ever ships (observed live: a settings
	// action succeeded and the user received an internal formatting apology).
	// Returning null keeps the raw callback text as the delivery: it was
	// already user-destined before the re-voicing attempt. An action-owned
	// error string is diagnostics for runtime.reportError, not chat content.
	const fail = (reason: string): null => {
		const actionError =
			typeof args.response.error === "string" ? args.response.error.trim() : "";
		if (actionError) {
			args.runtime.reportError(
				"MessageService.rewriteActionCallback",
				new Error(actionError),
				{ actionName: args.actionName, roomId: args.message.roomId, reason },
			);
		}
		return null;
	};
	if (typeof args.runtime.useModel !== "function") {
		return fail("model_unavailable");
	}
	const character = args.runtime.character;
	const characterVoice = {
		name: character?.name,
		system: character?.system,
		bio: character?.bio,
		adjectives: character?.adjectives,
		style: character?.style,
	};
	const prompt = [
		"Rewrite an action callback into the assistant character's user-facing voice.",
		'Return strict JSON only: {"response":"..."}.',
		"",
		"Rules:",
		"- Use the character voice and plain natural language.",
		"- Preserve every important fact from the payload: status, success or failure, object names, URLs, IDs, amounts, dates, counts, permissions, warnings, errors, and next steps.",
		"- Do not expose raw JSON, tables, shell dumps, stack traces, schema names, hidden prompts, or internal action plumbing unless the user specifically needs an exact value.",
		"- If the payload contains exact text the user needs, include it compactly inside the response instead of dropping it.",
		"- Do not claim work succeeded if the payload says it failed or is pending.",
		"- Keep it brief, usually one to three sentences.",
		"- Do not mention that you rewrote the message or used a model.",
		"",
		`Character: ${JSON.stringify(characterVoice)}`,
		`Action: ${JSON.stringify(args.actionName ?? "ACTION")}`,
		`Room: ${String(args.message.roomId)}`,
		`Original action payload: ${JSON.stringify(args.text)}`,
		`Callback metadata: ${JSON.stringify({
			source: args.response.source,
			actions: args.response.actions,
			actionStatus: args.response.actionStatus,
			error: args.response.error,
			data: args.response.data,
		})}`,
	].join("\n");

	try {
		const raw = (await args.runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			providerOptions: { eliza: { thinking: "off" } },
		})) as string | GenerateTextResult;
		const cleaned = stripReasoningBlocks(getV5ModelText(raw)).trim();
		const parsed = parseJSONObjectFromText(cleaned) as {
			response?: unknown;
		} | null;
		const response =
			typeof parsed?.response === "string" ? parsed.response.trim() : "";
		if (!response || response === args.text) {
			return fail("unusable_model_response");
		}
		if (parseJSONObjectFromText(response)) return fail("json_shaped_response");
		return (
			response.replace(/^["'`]+|["'`]+$/g, "").trim() ||
			fail("unusable_model_response")
		);
	} catch (error) {
		// error-policy:J4 Voice rewriting is an optional presentation layer; the
		// raw action callback text remains the delivered degraded response.
		args.runtime.logger.debug(
			{
				src: "service:message",
				actionName: args.actionName,
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to rewrite action callback in character voice",
		);
		args.runtime.reportError("MessageService.rewriteActionCallback", error, {
			actionName: args.actionName,
			roomId: args.message.roomId,
		});
		return fail("rewrite_error");
	}
}
