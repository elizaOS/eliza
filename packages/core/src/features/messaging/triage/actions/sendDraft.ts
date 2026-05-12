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

function inferSourceFromText(text: string): string | undefined {
	const lower = text.toLowerCase();
	if (/\btelegram\b/.test(lower)) return "telegram";
	if (/\bdiscord\b/.test(lower)) return "discord";
	if (/\bsignal\b/.test(lower)) return "signal";
	if (/\bwhatsapp\b/.test(lower)) return "whatsapp";
	if (/\b(imessage|sms|text)\b/.test(lower)) return "imessage";
	if (/\b(email|gmail|mail)\b/.test(lower)) return "gmail";
	if (/\b(twitter|x)\b/.test(lower)) return "twitter";
	return undefined;
}

function inferBodyFromText(text: string): string | undefined {
	const quoted = text.match(/['"]([^'"]{1,1000})['"]/);
	if (quoted?.[1]) return quoted[1].trim();
	const saying = text.match(/\b(?:saying|that|with the message)\b\s+(.+)$/i);
	return saying?.[1]?.trim();
}

function cleanRecipient(value: string): string {
	return value
		.replace(
			/\b(on|via|using)\s+(telegram|discord|signal|whatsapp|gmail|email|twitter|x|imessage|sms)\b/gi,
			"",
		)
		.replace(
			/\b(discord|telegram|signal|whatsapp|gmail|email|twitter|x|imessage|sms)\s+(channel|room|dm|message)\b/gi,
			"",
		)
		.replace(/\b(channel|room|dm|message)\b/gi, "")
		.trim();
}

function inferRecipientFromText(text: string): string | undefined {
	const patterns = [
		/\bto\s+(.+?)\s+\b(?:saying|that|with the message)\b/i,
		/\bto\s+the\s+(.+?)\s+\b(?:discord|telegram|signal|whatsapp|gmail|email|twitter|x|imessage|sms)\b/i,
		/\bto\s+(.+?)$/i,
		/\bdm\s+(.+?)\s+\bon\b/i,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		const value = match?.[1] ? cleanRecipient(match[1]) : "";
		if (value) return value;
	}
	return undefined;
}

function outboundDraftOptionsFromMessage(
	message: Memory,
	options: HandlerOptions | undefined,
): HandlerOptions | undefined {
	const params = getParameters(options);
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	const source =
		normalizeSource(
			params.source ?? params.platform ?? params.connector ?? params.service,
		) ?? inferSourceFromText(text);
	const body =
		nonEmptyString(
			params.body ?? params.text ?? params.message ?? params.content,
		) ?? inferBodyFromText(text);
	const rawTo =
		params.to ??
		params.recipient ??
		params.target ??
		params.channel ??
		params.room ??
		inferRecipientFromText(text);
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
		"owner outbound message draft/send confirmation-gated; use for Telegram Signal Discord email SMS/iMessage/DM send requests; never sends without confirmed=true",
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
				outboundDraftOptionsFromMessage(_message, options),
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
