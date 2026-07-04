/**
 * The outbound compose-and-send action for the messaging-triage capability,
 * registered under the shared `MESSAGE` action name. When no draft id is
 * supplied it extracts the target platform, recipient, and body from the user's
 * request (via `outboundDraftOptionsFromMessage`, which is model-driven so it
 * works in any language) and persists a draft; when a draft id is supplied it
 * sends that draft. If the TriageService adapter cannot create a draft it falls
 * back to a locally stored draft so the confirmation flow still works.
 *
 * Two independent gates guard every send. The user-confirmation gate refuses to
 * send without an explicit `confirmed: true`, returning a preview instead; the
 * owner SendPolicy gate (when a policy is registered) can defer any send for
 * owner approval, enqueuing the sendDraft executor for later replay.
 *
 * `outboundDraftOptionsFromMessage` is exported for the unit tests in
 * `sendDraft.test.ts`.
 */
import crypto from "node:crypto";
import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionParameter,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { ModelType } from "../../../../types/index.ts";
import { parseKeyValueXml } from "../../../../utils.ts";
import { getSendPolicy } from "../send-policy.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import type { DraftRecord, DraftRequest } from "../types.ts";
import {
	bodyParameter,
	draftIdParameter,
	parseDraftFollowupParams,
	parseSendDraftParams,
	validateMessageAction,
} from "./_shared.ts";

const OUTBOUND_DRAFT_PARAMETERS: ActionParameter[] = [
	{
		name: "source",
		description:
			"Message source for a new outbound draft, such as gmail, discord, telegram, signal, imessage, whatsapp, or twitter.",
		required: false,
		schema: { type: "string" as const },
	},
	{
		name: "to",
		description:
			"Recipient identifiers, contact names, handles, channels, rooms, or recipient objects for a new outbound draft.",
		required: false,
		schema: {
			type: "array" as const,
			items: { type: "string" as const },
		},
	},
	{ ...bodyParameter, required: false },
	{
		name: "subject",
		description: "Optional subject for email-like sources.",
		required: false,
		schema: { type: "string" as const },
	},
	{
		name: "threadId",
		description: "Optional existing thread identifier.",
		required: false,
		schema: { type: "string" as const },
	},
];

function getParameters(
	options: HandlerOptions | undefined,
): Record<string, unknown> {
	const params = options?.parameters;
	return params && typeof params === "object" && !Array.isArray(params)
		? (params as Record<string, unknown>)
		: {};
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function normalizeSource(value: unknown): string | undefined {
	const raw = nonEmptyString(value)?.toLowerCase();
	if (!raw) return undefined;
	if (raw === "x" || raw === "twitter") return "twitter";
	if (raw === "email" || raw === "mail") return "gmail";
	if (raw === "sms" || raw === "text") return "imessage";
	return raw;
}

/**
 * Extract the outbound-draft fields (platform, recipient, message body) the user
 * asked to send, using the model's structured output instead of English-only
 * regex/keyword parsing (#10470). Fields the request doesn't specify come back
 * empty; the caller still enforces that a body + recipient are present. Falls
 * back to `{}` (no extraction) if the model call fails — the action then reports
 * the missing details, never a wrong guess.
 */
async function extractOutboundDraftFromText(
	runtime: IAgentRuntime,
	text: string,
): Promise<{ source?: string; recipient?: string; body?: string }> {
	if (!text.trim()) return {};
	const prompt = `A user asked the agent to send an outbound message. Extract the parts of the request — this must work in any language, so do not rely on English keywords.

Request:
${text}

Return ONLY this XML, leaving a field empty when the request does not specify it:
<response>
<source>the platform/app to send on — one of telegram, discord, signal, whatsapp, imessage, gmail, twitter — or empty</source>
<recipient>who to send to (a name, @handle, or contact), or empty</recipient>
<body>the exact message text to send, or empty</body>
</response>`;
	let raw: string;
	try {
		raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
	} catch (error) {
		logger.warn(
			`[SendDraft] outbound-draft extraction failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return {};
	}
	// Tolerate models that omit the wrapper or wrap the XML in a code fence —
	// parseKeyValueXml reads the direct children of a <response> block.
	const cleaned = raw.replace(/```(?:xml)?/gi, "").trim();
	const wrapped = cleaned.includes("<response>")
		? cleaned
		: `<response>${cleaned}</response>`;
	const parsed = parseKeyValueXml(wrapped) ?? {};
	return {
		source: nonEmptyString(parsed.source),
		recipient: nonEmptyString(parsed.recipient),
		body: nonEmptyString(parsed.body),
	};
}

export async function outboundDraftOptionsFromMessage(
	runtime: IAgentRuntime,
	message: Memory,
	options: HandlerOptions | undefined,
): Promise<HandlerOptions | undefined> {
	const params = getParameters(options);
	const text =
		typeof message.content.text === "string" ? message.content.text : "";

	// Structured params from the planner/tool-call win; only invoke the model to
	// fill the gaps (cheap no-LLM fast path when they are already complete).
	const paramSource = normalizeSource(
		params.source ?? params.platform ?? params.connector ?? params.service,
	);
	const paramBody = nonEmptyString(
		params.body ?? params.text ?? params.message ?? params.content,
	);
	const paramTo =
		params.to ??
		params.recipient ??
		params.target ??
		params.channel ??
		params.room;
	const haveParamTo = Array.isArray(paramTo)
		? paramTo.length > 0
		: nonEmptyString(paramTo) !== undefined;

	const extracted =
		paramSource && paramBody && haveParamTo
			? {}
			: await extractOutboundDraftFromText(runtime, text);

	const source = paramSource ?? normalizeSource(extracted.source);
	const body = paramBody ?? extracted.body;
	const rawTo = paramTo ?? extracted.recipient;
	const to = Array.isArray(rawTo)
		? rawTo
		: nonEmptyString(rawTo)
			? [rawTo]
			: undefined;

	return {
		...options,
		parameters: {
			...params,
			...(source ? { source } : {}),
			...(body ? { body } : {}),
			...(to ? { to } : {}),
		},
	};
}

function previewOutboundDraft(
	record: Pick<DraftRecord, "source" | "to" | "body" | "subject">,
): string {
	const recipients = record.to
		.map((recipient) => recipient.displayName ?? recipient.identifier)
		.join(", ");
	const subject = record.subject ? `Subject: ${record.subject}\n` : "";
	return `[${record.source}] To: ${recipients}\n${subject}${record.body}`;
}

function saveLocalOutboundDraft(args: {
	service: ReturnType<typeof getDefaultTriageService>;
	source: DraftRecord["source"];
	to: DraftRecord["to"];
	body: string;
	subject?: string;
	threadId?: string;
	worldId?: string;
	channelId?: string;
}): DraftRecord {
	const partial = {
		source: args.source,
		to: args.to,
		body: args.body,
		subject: args.subject,
	};
	const record: DraftRecord = {
		draftId: `local:${crypto.randomUUID()}`,
		source: args.source,
		to: args.to,
		body: args.body,
		subject: args.subject,
		threadId: args.threadId,
		worldId: args.worldId,
		channelId: args.channelId,
		preview: previewOutboundDraft(partial),
		createdAtMs: Date.now(),
		sent: false,
	};
	args.service.getStore().saveDraft(record);
	return record;
}

/**
 * SAFETY INVARIANT: MESSAGE must never send without an explicit
 * `confirmed: true` parameter. When confirmation is missing the handler
 * returns the preview and asks the user to confirm.
 */
export const sendDraftAction: Action = {
	name: "MESSAGE",
	contexts: ["messaging", "email", "contacts"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Create or send an owner-scoped outbound message draft. Use this for first-turn requests like 'send a Telegram message to Jane saying I am late', 'DM Bob on Discord', 'email Alice the notes', and 'text Sam that I am outside'. Without confirmed=true it only creates or previews the draft and asks for confirmation; it never sends directly.",
	descriptionCompressed:
		"outbound draft/send Telegram|Signal|Discord|email|SMS|iMessage|DM; requires confirmed=true",
	similes: [
		"DISPATCH_DRAFT",
		"CONFIRM_AND_SEND",
		"COMPOSE_MESSAGE",
		"OUTBOUND_MESSAGE",
	],
	parameters: [
		{ ...draftIdParameter, required: false },
		{
			name: "confirmed",
			description: "Whether the user explicitly confirmed sending the draft.",
			required: false,
			schema: { type: "boolean" as const, default: false },
		},
		...OUTBOUND_DRAFT_PARAMETERS,
	],
	examples: [
		[
			{
				name: "User",
				content: { text: "Send the draft" },
			},
			{
				name: "Agent",
				content: {
					text: "Sent.",
					action: "MESSAGE",
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => validateMessageAction(message, state),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const parsed = parseSendDraftParams(options);
		const service = getDefaultTriageService();
		if ("error" in parsed) {
			const draftParsed = parseDraftFollowupParams(
				await outboundDraftOptionsFromMessage(runtime, _message, options),
			);
			if ("error" in draftParsed) {
				const text = `Could not create outbound draft: ${draftParsed.error}.`;
				logger.warn(`[SendDraft] ${text}`);
				return {
					success: false,
					text,
					error: draftParsed.error,
					continueChain: false,
					data: {
						actionName: "MESSAGE",
						error: "MISSING_DRAFT_DETAILS",
						requiresInput: true,
					},
				};
			}

			let record: DraftRecord;
			try {
				record = await service.draftFollowup(runtime, {
					source: draftParsed.source,
					to: draftParsed.to,
					subject: draftParsed.subject,
					body: draftParsed.body,
					threadId: draftParsed.threadId,
					worldId: draftParsed.worldId,
					channelId: draftParsed.channelId,
				});
			} catch (error) {
				const messageText =
					error instanceof Error ? error.message : String(error);
				if (!/NotYetImplemented|createDraft/i.test(messageText)) {
					throw error;
				}
				record = saveLocalOutboundDraft({
					service,
					source: draftParsed.source,
					to: draftParsed.to,
					subject: draftParsed.subject,
					body: draftParsed.body,
					threadId: draftParsed.threadId,
					worldId: draftParsed.worldId,
					channelId: draftParsed.channelId,
				});
			}
			const recipients = record.to
				.map((recipient) => recipient.displayName ?? recipient.identifier)
				.join(", ");
			const text = `Drafted ${record.source} message to ${recipients}. Preview: ${record.preview}. Confirm before I send it.`;
			logger.info(
				`[SendDraft] created outbound draft draftId=${record.draftId} source=${record.source}`,
			);
			if (callback) {
				await callback({ text, action: "MESSAGE" });
			}
			return {
				success: false,
				text,
				continueChain: false,
				data: {
					requiresConfirmation: true,
					preview: record.preview,
					draftId: record.draftId,
					source: record.source,
					to: record.to,
				},
			};
		}

		const existing = service.getStore().getDraft(parsed.draftId);
		if (!existing) {
			const msg = `No draft found for id ${parsed.draftId}`;
			logger.warn(`[SendDraft] ${msg}`);
			return { success: false, text: msg, error: msg };
		}

		if (!parsed.confirmed) {
			const text = `Confirmation required before sending draft ${parsed.draftId}. Preview: ${existing.preview}`;
			logger.info(`[SendDraft] confirmation gate: draftId=${parsed.draftId}`);
			if (callback) {
				await callback({ text, action: "MESSAGE" });
			}
			return {
				success: false,
				text,
				continueChain: false,
				data: {
					requiresConfirmation: true,
					preview: existing.preview,
					draftId: existing.draftId,
					source: existing.source,
				},
			};
		}

		// Owner-policy gate (separate from the user-confirmation gate above):
		// hosts can register a SendPolicy that defers any outbound send until
		// owner approval. When the policy enqueues, we report pending and
		// hand the executor (sendDraft) over for later replay.
		const policy = getSendPolicy(runtime);
		if (policy) {
			const draftReq: DraftRequest = {
				source: existing.source,
				inReplyToId: existing.inReplyToId,
				threadId: existing.threadId,
				to: existing.to,
				subject: existing.subject,
				body: existing.body,
				worldId: existing.worldId,
				channelId: existing.channelId,
				metadata: existing.metadata,
			};
			const required = await policy.shouldRequireApproval(runtime, draftReq);
			if (required) {
				const enq = await policy.enqueueApproval(runtime, draftReq, () =>
					service.sendDraft(runtime, parsed.draftId).then((rec) => ({
						externalId: rec.sentExternalId ?? `pending:${rec.draftId}`,
					})),
				);
				const text = `Draft ${parsed.draftId} pending owner approval (request ${enq.requestId}).`;
				logger.info(
					`[SendDraft] policy hold: draftId=${parsed.draftId} requestId=${enq.requestId}`,
				);
				if (callback) {
					await callback({ text, action: "MESSAGE" });
				}
				return {
					success: false,
					text,
					continueChain: false,
					data: {
						requiresConfirmation: true,
						pending: true,
						requestId: enq.requestId,
						preview: enq.preview,
						draftId: existing.draftId,
						source: existing.source,
					},
				};
			}
		}

		const sent = await service.sendDraft(runtime, parsed.draftId);
		const text = `Sent draft ${parsed.draftId} on ${sent.source}.`;
		logger.info(
			`[SendDraft] sent draftId=${parsed.draftId} externalId=${sent.sentExternalId ?? "unknown"}`,
		);
		if (callback) {
			await callback({ text, action: "MESSAGE" });
		}
		return {
			success: true,
			text,
			data: {
				draftId: sent.draftId,
				source: sent.source,
				externalId: sent.sentExternalId ?? null,
			},
		};
	},
};
