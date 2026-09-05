/**
 * The outbound compose-and-send action for the messaging-triage capability,
 * registered under the shared `MESSAGE` action name. When no draft id is
 * supplied it extracts the target platform, recipient, and body from the user's
 * request (via `outboundDraftOptionsFromMessage`, which is model-driven so it
 * works in any language) and persists a draft; when a draft id is supplied it
 * sends that draft — but only after a real user turn confirmed the previewed
 * draft (#25284). If the TriageService adapter cannot create a draft it falls
 * back to a locally stored draft so the confirmation flow still works.
 *
 * Two independent gates guard every send. The user-consent gate
 * (`gateSendDraftConsent`) refuses to send until a subsequent user turn — never
 * a planner-authored parameter — answers the preview with an unqualified
 * affirmative for the exact same draft snapshot, actor, and room; the owner
 * SendPolicy gate (when a policy is registered) can defer any send for owner
 * approval, enqueuing the sendDraft executor for later replay.
 *
 * `outboundDraftOptionsFromMessage` is exported for the unit tests in
 * `sendDraft.test.ts`.
 */
import crypto from "node:crypto";
import { ElizaError } from "../../../../errors.ts";
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
import {
	type DraftRecord,
	type DraftRequest,
	NotYetImplementedError,
} from "../types.ts";
import {
	bodyParameter,
	draftIdParameter,
	parseDraftFollowupParams,
	parseSendDraftParams,
	validateMessageAction,
} from "./_shared.ts";
import {
	draftConsentDigest,
	gateSendDraftConsent,
	PRINCIPAL_RANK_USER,
	resolveMessagePrincipalRole,
} from "./send-consent.ts";

const OUTBOUND_DRAFT_PARAMETERS: ActionParameter[] = [
	{
		name: "source",
		description:
			"Message source for a new outbound draft, such as gmail, discord, telegram, imessage, whatsapp, or twitter.",
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
 * empty; the caller still enforces that a body + recipient are present. Model
 * failures propagate through the action boundary so an outage is never
 * presented as missing user input.
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
<source>the platform/app to send on — one of telegram, discord, whatsapp, imessage, gmail, twitter — or empty</source>
<recipient>who to send to (a name, @handle, or contact), or empty</recipient>
<body>the exact message text to send, or empty</body>
</response>`;
	const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
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
 * SAFETY INVARIANT: MESSAGE must never send on planner-authored arguments. The
 * `confirmed` boolean is gone from the parameter surface; a send is authorized
 * only by `gateSendDraftConsent`, which requires a real subsequent user turn
 * (#25284).
 */
export const sendDraftAction: Action = {
	name: "MESSAGE",
	contexts: ["messaging", "email", "contacts"],
	// USER+ per #25284: owned/delegated delivery is a user capability; GUEST is
	// denied. This leaf is only reachable through the umbrella MESSAGE action,
	// which keeps its own exposure gate; this floor is the send-specific
	// admission the umbrella cannot express per-op.
	roleGate: { minRole: "USER" },
	description:
		"Create or send an owner-scoped outbound message draft. Use this for first-turn requests like 'send a Telegram message to Jane saying I am late', 'DM Bob on Discord', 'email Alice the notes', and 'text Sam that I am outside'. It creates or previews the draft and asks for confirmation; a later user reply that confirms the preview is the only thing that sends it.",
	descriptionCompressed:
		"outbound draft/send Telegram|Discord|email|SMS|iMessage|WhatsApp|DM; send requires a confirming user turn",
	similes: [
		"DISPATCH_DRAFT",
		"CONFIRM_AND_SEND",
		"COMPOSE_MESSAGE",
		"OUTBOUND_MESSAGE",
	],
	parameters: [
		{ ...draftIdParameter, required: false },
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
				if (!(error instanceof NotYetImplementedError)) {
					throw error;
				}
				// error-policy:J4 Adapters may explicitly decline remote draft creation;
				// a `local:` draft is a visibly distinct, sendable confirmation artifact.
				runtime.reportError("SendDraft.remoteDraftUnavailable", error, {
					source: draftParsed.source,
				});
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
			// Arm the consent gate at creation (#25284 review round 2): the
			// preview this turn shows is the one the next user turn answers,
			// instead of leaving the draft un-armed and demanding a second
			// confirm cycle.
			const armed = await gateSendDraftConsent({
				runtime,
				message: _message,
				draft: record,
			});
			logger.info(
				`[SendDraft] consent armed at creation: status=${armed.status} draftId=${record.draftId}`,
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

		// Per-op principal admission (#25284): the umbrella MESSAGE gate covers
		// exposure, but send_draft specifically admits USER+ (owned/delegated
		// delivery) and denies GUEST. Fail closed when the sender's role cannot
		// be resolved.
		const admission = await resolveMessagePrincipalRole(runtime, _message);
		if (admission.rank < PRINCIPAL_RANK_USER) {
			const text = `Sending drafts requires at least user access; the current caller is ${admission.role}.`;
			logger.warn(
				`[SendDraft] role denied: role=${admission.role} draftId=${parsed.draftId}`,
			);
			return {
				success: false,
				text,
				error: "SEND_PRINCIPAL_ROLE_DENIED",
				data: {
					actionName: "MESSAGE",
					error: "SEND_PRINCIPAL_ROLE_DENIED",
					callerRole: admission.role,
				},
			};
		}

		const consent = await gateSendDraftConsent({
			runtime,
			message: _message,
			draft: existing,
		});
		if (consent.status !== "confirmed") {
			const text =
				consent.status === "cancelled"
					? "Cancelled — I won't send that draft."
					: `Here's what I'm about to send: ${existing.preview} — want me to send it?`;
			const data =
				consent.status === "cancelled"
					? {
							requiresConfirmation: false,
							cancelled: true,
							draftId: existing.draftId,
							source: existing.source,
						}
					: {
							requiresConfirmation: true,
							preview: existing.preview,
							draftId: existing.draftId,
							source: existing.source,
							to: existing.to,
						};
			logger.info(
				`[SendDraft] consent gate: status=${consent.status} draftId=${parsed.draftId}`,
			);
			if (callback) {
				await callback({ text, action: "MESSAGE" });
			}
			return {
				// A pending preview ask completes the turn; a refusal completes it
				// too. Both are the designed ask/answer, not failures.
				success: true,
				text,
				userFacingText: text,
				verifiedUserFacing: true,
				turnComplete: true,
				continueChain: false,
				data: {
					...data,
					consentStatus: consent.status,
				},
			};
		}

		// Owner-policy gate (separate from the user-consent gate above):
		// hosts can register a SendPolicy that defers any outbound send until
		// owner approval. When the policy enqueues, we report pending and
		// hand the executor (sendDraft) over for later replay.
		const consentedDigest = draftConsentDigest(existing);
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
					// Bind the replay to the consented snapshot too (#25284): if
					// the draft mutates between consent and owner-approved
					// replay, the send fails closed instead of delivering
					// unconsented bytes.
					service
						.sendDraft(runtime, parsed.draftId, consentedDigest)
						.then((rec) => ({
							externalId: rec.sentExternalId ?? `pending:${rec.draftId}`,
						})),
				);
				// The pending-approval notice is the complete answer to this turn:
				// verified + turnComplete make it the sole delivery, human-worded;
				// draft/request ids stay planner-facing in data.
				const text =
					"This one needs the owner's approval before it goes out — I've requested it and will send it once approved.";
				logger.info(
					`[SendDraft] policy hold: draftId=${parsed.draftId} requestId=${enq.requestId}`,
				);
				if (callback) {
					await callback({ text, action: "MESSAGE" });
				}
				return {
					success: true,
					text,
					userFacingText: text,
					verifiedUserFacing: true,
					turnComplete: true,
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

		const sent = await service
			.sendDraft(runtime, parsed.draftId, consentedDigest)
			.catch((error: unknown) => {
				// error-policy:J1 boundary translation — the consented snapshot no
				// longer matches the stored draft (mutated between the gate and
				// the provider call). Fail closed: nothing went out; re-preview so
				// the next user turn consents the bytes that exist now (#25284).
				if (
					error instanceof ElizaError &&
					error.code === "MESSAGE_DRAFT_CONSENT_DIGEST_MISMATCH"
				) {
					logger.warn(
						`[SendDraft] consented snapshot mismatch: draftId=${parsed.draftId} — re-previewing`,
					);
					return null;
				}
				throw error;
			});
		if (!sent) {
			const fresh = service.getStore().getDraft(parsed.draftId);
			// Arm the consent for the preview we are about to show (#25284
			// r3): the mismatch preview must be confirmable by the NEXT user
			// turn, not just re-displayed. If arming fails, the recovery is
			// a visibly DEGRADED state — an explicit retry hint, never a
			// confirmation prompt that was not actually armed (the next bare
			// yes would only re-ask, misrepresenting the gate).
			let armed = false;
			if (fresh) {
				const gate = await gateSendDraftConsent({
					runtime,
					message: _message,
					draft: fresh,
				}).catch(() => {
					/* error-policy:J4 arming failure degrades to an explicit retry ask below */
					return null;
				});
				armed = gate?.status === "pending" || gate?.status === "stale";
			}
			const text = !fresh
				? "That draft is no longer available."
				: armed
					? `That draft changed after you approved it — here's the current version: ${fresh.preview} — still want me to send it?`
					: "That draft changed after you approved it, and I couldn't stage a new confirmation right now — please ask me to send it again in a moment.";
			const data = fresh
				? {
						requiresConfirmation: true,
						preview: armed ? fresh.preview : "",
						draftId: parsed.draftId,
						source: fresh.source,
						consentArmed: armed,
					}
				: {
						requiresConfirmation: false,
						draftId: parsed.draftId,
						source: existing.source,
						consentArmed: false,
					};
			if (callback) {
				await callback({ text, action: "MESSAGE" });
			}
			return {
				success: true,
				text,
				userFacingText: text,
				verifiedUserFacing: true,
				turnComplete: true,
				continueChain: false,
				data,
			};
		}
		// The sent confirmation is the complete answer to a single-operation
		// turn: verified + turnComplete make it the sole delivery; the draftId
		// stays planner-facing in data.
		const text = "Sent it.";
		logger.info(
			`[SendDraft] sent draftId=${parsed.draftId} externalId=${sent.sentExternalId ?? "unknown"}`,
		);
		if (callback) {
			await callback({ text, action: "MESSAGE" });
		}
		return {
			success: true,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			turnComplete: true,
			data: {
				draftId: sent.draftId,
				source: sent.source,
				externalId: sent.sentExternalId ?? null,
			},
		};
	},
};
