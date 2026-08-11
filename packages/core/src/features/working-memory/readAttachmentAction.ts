/**
 * Implements the ATTACHMENT action of the working-memory capability: an
 * ADMIN-gated action that reads or persists attachments, link previews, and media
 * already present in the current conversation (it never fetches new URLs — that
 * routes to WEB_FETCH). action=read gathers the readable content and, per the
 * request, answers the user's question via a TEXT_SMALL call, returns an
 * attachment metadata record, or stashes the content into the bounded task
 * clipboard; action=save_as_document writes the content to the DocumentService.
 *
 * Attachment gathering and selection are delegated to attachmentContext.ts,
 * clipboard persistence to taskClipboardPersistence.ts, and document storage to
 * features/documents. readAttachmentActionKind resolves the operation purely from
 * the planner-emitted enum, deliberately doing no natural-language keyword
 * inference so routing stays language-agnostic (#10471).
 */

import { ElizaError } from "../../errors.ts";
import { fetchAttachmentBytes } from "../../media/attachment-bytes.ts";
import { MediaFetchError } from "../../media/fetch.ts";
import { TRANSCRIPTION_EMPTY_RESULT_MARKER } from "../../media/transcription.ts";
import {
	linkShareOwnText,
	looksLikeBareLinkShare,
} from "../../services/message/direct-action-heuristics.ts";
import {
	type Action,
	type ActionResult,
	ContentType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	ModelType,
	type State,
	type UUID,
} from "../../types/index.ts";
import { DocumentService } from "../documents/service.ts";
import {
	createDocumentNoteFilename,
	deriveDocumentTitle,
} from "../documents/utils.ts";
import {
	listConversationAttachments,
	readAttachmentRecords,
	summarizeAttachment,
} from "./attachmentContext.ts";
import { maybeStoreTaskClipboardItem } from "./taskClipboardPersistence.ts";

const ATTACHMENT_ACTIONS = ["read", "save_as_document"] as const;
const MAX_ATTACHMENT_ANSWER_CHARS = 32_000;
const MIN_ATTACHMENT_ANSWER_TOKENS = 1024;
const MAX_ATTACHMENT_ANSWER_TOKENS = 4096;
/** A bare link share wants a one-to-two sentence reaction, not a page digest. */
const BARE_LINK_ANSWER_TOKENS = 256;
const ATTACHMENT_ACTION_PARAMETER_KEYS = [
	"action",
	"subaction",
	"op",
	"attachmentId",
	"id",
	"addToClipboard",
	"persistToClipboard",
	"saveToClipboard",
	"clipboardTitle",
	"title",
	"scope",
] as const;
type AttachmentAction = (typeof ATTACHMENT_ACTIONS)[number];
type AttachmentRecord = Awaited<
	ReturnType<typeof readAttachmentRecords>
>[number];

function shouldShowAttachmentRecord(messageText: string): boolean {
	return /\b(?:attachment|file)\s+(?:id|ids|metadata|details|info|record)\b/i.test(
		messageText,
	);
}

/** Question or explicit-ask phrasing in the user's own words (URLs and
 * connector embed previews excluded, so a page title like "What is X?" never
 * counts as the user asking). */
const LINK_SHARE_ASK_PATTERN =
	/(?:\?|\b(?:what|who|when|where|why|how|which|explain|summarize|summarise|summary|tldr|tl;dr|thoughts|opinion|review|eli5|tell\s+me|can\s+you|could\s+you|would\s+you)\b)/iu;

/**
 * True for "here's a link" with no actual ask. looksLikeBareLinkShare alone is
 * a ROUTING predicate — it also accepts a short question next to the link
 * (both fetch the page) — but a question wants the question answered, not a
 * one-take page summary.
 */
function isLinkShareWithoutAsk(text: string): boolean {
	return (
		looksLikeBareLinkShare(text) &&
		!LINK_SHARE_ASK_PATTERN.test(linkShareOwnText(text))
	);
}

function attachmentContentForAnswering(content: string): string {
	if (content.length <= MAX_ATTACHMENT_ANSWER_CHARS) {
		return content;
	}
	return `${content.slice(0, MAX_ATTACHMENT_ANSWER_CHARS)}\n\n[Attachment content truncated before answering because it exceeded ${MAX_ATTACHMENT_ANSWER_CHARS} characters.]`;
}

function attachmentAnswerTokenBudget(content: string): number {
	const estimatedTokens = Math.ceil(content.length / 4);
	return Math.min(
		Math.max(estimatedTokens, MIN_ATTACHMENT_ANSWER_TOKENS),
		MAX_ATTACHMENT_ANSWER_TOKENS,
	);
}

function isMediaAttachment(record: AttachmentRecord): boolean {
	return (
		record.attachment.contentType === ContentType.AUDIO ||
		record.attachment.contentType === ContentType.VIDEO
	);
}

/**
 * True when a media record's transcript is missing because transcription
 * itself was unavailable (ingest or on-demand), not because nobody has asked
 * yet. `notProcessed` carries the raw provider error; the user-facing message
 * must stay a clean sentence, never that internal prose.
 */
function mediaTranscriptionUnavailable(records: AttachmentRecord[]): boolean {
	return records.some(
		(record) =>
			isMediaAttachment(record) &&
			typeof record.attachment.notProcessed === "string" &&
			/transcription unavailable/i.test(record.attachment.notProcessed),
	);
}

function mediaTranscriptionReturnedNoText(
	records: AttachmentRecord[],
): boolean {
	return records.every(
		(record) =>
			isMediaAttachment(record) &&
			record.attachment.notProcessed === TRANSCRIPTION_EMPTY_RESULT_MARKER,
	);
}

function missingReadableContentMessage(records: AttachmentRecord[]): string {
	const hasOnlyImages = records.every(
		(record) => record.attachment.contentType === ContentType.IMAGE,
	);
	if (hasOnlyImages) {
		return records.length === 1
			? "I couldn't generate a readable description for that image."
			: "I couldn't generate readable descriptions for those images.";
	}
	const hasOnlyMedia = records.every(isMediaAttachment);
	if (hasOnlyMedia) {
		if (mediaTranscriptionReturnedNoText(records)) {
			return records.length === 1
				? "I couldn't find any speech to transcribe in that attachment."
				: "I couldn't find any speech to transcribe in those attachments.";
		}
		// Honest unavailability beats an open-ended "yet": when no TRANSCRIPTION
		// provider can serve, "yet" incorrectly promises that retrying can help.
		if (mediaTranscriptionUnavailable(records)) {
			return records.length === 1
				? "I can't transcribe that attachment — speech-to-text isn't enabled on this deployment."
				: "I can't transcribe those attachments — speech-to-text isn't enabled on this deployment.";
		}
		return records.length === 1
			? "I don't have a transcript for that attachment yet."
			: "I don't have transcripts for those attachments yet.";
	}
	return records.length === 1
		? "I don't have readable text for that attachment yet."
		: "I don't have readable text for those attachments yet.";
}

/**
 * True when a TRANSCRIPTION failure means no provider can serve at all —
 * a provider's *UnavailableError fall-through (e.g. `CloudSttUnavailableError`)
 * or the runtime having no registered handler — as opposed to a transient
 * failure (network blip, provider 5xx) that a later retry could clear. Only
 * the former may claim "speech-to-text isn't enabled" to the user.
 */
function isTranscriptionUnavailableError(err: unknown): err is Error {
	// Remote and local byte-loader failures are transient fetch failures. Their
	// diagnostic text may include a hostile response body, so typed provenance
	// must win before any provider-message compatibility check.
	if (err instanceof MediaFetchError) return false;
	if (!(err instanceof Error)) return false;
	if (err.name.endsWith("UnavailableError")) return true;
	return /falling through to next TRANSCRIPTION handler|no (?:model )?handler.*TRANSCRIPTION|TRANSCRIPTION.*not (?:available|enabled|registered)/i.test(
		err.message,
	);
}

type AttachmentTranscriptionState =
	| { kind: "transcript"; text: string }
	| { kind: "empty" };

/**
 * Publish an on-demand result through the owning message row before exposing it
 * to this read. Re-reading the fresh row then needs neither byte fetch nor STT,
 * while a failed write leaves the attachment retryable instead of claiming an
 * ephemeral transcript was stored.
 */
async function persistAttachmentTranscription(
	runtime: IAgentRuntime,
	record: AttachmentRecord,
	state: AttachmentTranscriptionState,
	roomHandlerLease?: HandlerOptions["roomHandlerLease"],
): Promise<void> {
	const attachmentId = record.attachment.id;
	if (!record.owningMemoryId) {
		throw new ElizaError(
			`Attachment ${attachmentId} has no owning message id`,
			{
				code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
				context: { attachmentId },
				severity: "ephemeral",
			},
		);
	}
	const owningMemoryId = record.owningMemoryId;
	const failureContext = { attachmentId, owningMemoryId };
	const ownerSnapshot = await runtime.getMemoryById(owningMemoryId);
	if (!ownerSnapshot) {
		throw new ElizaError(
			`Owning message ${owningMemoryId} is no longer available`,
			{
				code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
				context: failureContext,
				severity: "ephemeral",
			},
		);
	}

	await runtime.roomHandlerQueue.withLeases(
		[ownerSnapshot.roomId],
		async (leases) =>
			runtime.roomHandlerQueue.withLeaseWrites(leases, async () => {
				const owningMemory = await runtime.getMemoryById(owningMemoryId);
				if (!owningMemory) {
					throw new ElizaError(
						`Owning message ${owningMemoryId} is no longer available`,
						{
							code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
							context: failureContext,
							severity: "ephemeral",
						},
					);
				}
				if (owningMemory.roomId !== ownerSnapshot.roomId) {
					throw new ElizaError(
						`Owning message ${owningMemoryId} changed rooms before its attachment update`,
						{
							code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
							context: {
								...failureContext,
								expectedRoomId: ownerSnapshot.roomId,
								actualRoomId: owningMemory.roomId,
							},
							severity: "ephemeral",
						},
					);
				}
				const attachments = owningMemory.content.attachments;
				if (!Array.isArray(attachments)) {
					throw new ElizaError(
						`Owning message ${owningMemoryId} has no attachment collection`,
						{
							code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
							context: failureContext,
						},
					);
				}
				const matchingAttachments = attachments.filter(
					(attachment) => attachment.id === attachmentId,
				);
				if (matchingAttachments.length !== 1) {
					throw new ElizaError(
						`Attachment ${attachmentId} is not uniquely present on its owning message`,
						{
							code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
							context: failureContext,
						},
					);
				}
				if (matchingAttachments[0]?.url !== record.attachment.url) {
					throw new ElizaError(
						`Attachment ${attachmentId} changed before its transcription could be stored`,
						{
							code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
							context: failureContext,
						},
					);
				}

				const updatedAttachments = attachments.map((attachment) => {
					if (attachment.id !== attachmentId) return attachment;
					const updated = { ...attachment };
					if (state.kind === "transcript") {
						updated.text = state.text;
						updated.description = `Transcript: ${state.text}`;
						delete updated.notProcessed;
					} else {
						delete updated.text;
						if (updated.description?.startsWith("Transcript:")) {
							delete updated.description;
						}
						updated.notProcessed = TRANSCRIPTION_EMPTY_RESULT_MARKER;
					}
					return updated;
				});
				if (
					!(await runtime.updateMemory({
						id: owningMemoryId,
						content: {
							...owningMemory.content,
							attachments: updatedAttachments,
						},
					}))
				) {
					throw new ElizaError(
						`Owning message ${owningMemoryId} rejected its attachment update`,
						{
							code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
							context: failureContext,
							severity: "ephemeral",
						},
					);
				}

				const durableMemory = await runtime.getMemoryById(owningMemoryId);
				if (!durableMemory) {
					throw new ElizaError(
						`Owning message ${owningMemoryId} disappeared during its attachment update`,
						{
							code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
							context: failureContext,
							severity: "ephemeral",
						},
					);
				}
				const durableAttachments = durableMemory.content.attachments?.filter(
					(attachment) => attachment.id === attachmentId,
				);
				if (durableAttachments?.length !== 1) {
					throw new ElizaError(
						`Attachment ${attachmentId} was not durably updated on its owning message`,
						{
							code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
							context: failureContext,
						},
					);
				}
				const durableAttachment = durableAttachments[0];
				if (
					!durableAttachment ||
					durableAttachment.url !== record.attachment.url ||
					(state.kind === "transcript"
						? durableAttachment.text !== state.text ||
							durableAttachment.description !== `Transcript: ${state.text}` ||
							durableAttachment.notProcessed !== undefined
						: durableAttachment.text !== undefined ||
							durableAttachment.notProcessed !==
								TRANSCRIPTION_EMPTY_RESULT_MARKER ||
							durableAttachment.description?.startsWith("Transcript:") === true)
				) {
					throw new ElizaError(
						`Attachment ${attachmentId} did not retain its transcription update`,
						{
							code: "ATTACHMENT_TRANSCRIPTION_PERSIST_FAILED",
							context: failureContext,
						},
					);
				}

				record.attachment = { ...durableAttachment };
				record.content = state.kind === "transcript" ? state.text : "";
			}),
		roomHandlerLease ? { lease: roomHandlerLease } : undefined,
	);
}

/**
 * Retries media records whose ingest-time transcription produced nothing so a
 * deployment that regains STT can enrich already-stored attachments. Fetches
 * only the attachment's stored URL through core's bounded media boundary and
 * hands the provider bytes, never a new URL extracted from chat text. Success
 * fills the record from the durable owning message; capability unavailability
 * remains explicit, while retryable transport/provider failures yield "yet".
 */
async function transcribeMediaOnDemand(
	runtime: IAgentRuntime,
	records: AttachmentRecord[],
	roomHandlerLease?: HandlerOptions["roomHandlerLease"],
): Promise<void> {
	for (const record of records) {
		const { attachment } = record;
		if (!isMediaAttachment(record) || record.content.trim()) continue;
		// A redacted grant may point at derivative bytes but shares the source id.
		// Writing its transcript onto the source row would disclose or corrupt the
		// owner's artifact, so only the owning/original attachment is enrichable.
		if (attachment.redacted) continue;
		// A successful empty result is definitive stored state, not a provider
		// outage. Repeating the same byte/model work cannot create speech that was
		// absent from the attachment.
		if (attachment.notProcessed === TRANSCRIPTION_EMPTY_RESULT_MARKER) {
			continue;
		}
		if (typeof attachment.url !== "string" || !attachment.url.trim()) continue;
		let buffer: Buffer;
		try {
			({ buffer } = await fetchAttachmentBytes(runtime, attachment.url));
		} catch (err) {
			if (
				!(err instanceof MediaFetchError) ||
				(err.code !== "fetch_failed" && err.code !== "http_error")
			) {
				throw err;
			}
			// error-policy:J4 A bounded/guarded media fetch failure is a retryable
			// unavailable read; it never becomes a provider-capability verdict.
			delete attachment.notProcessed;
			logger.debug(
				{ attachmentId: attachment.id, err },
				"[ReadAttachment] On-demand media fetch failed",
			);
			continue;
		}

		let transcript: unknown;
		try {
			transcript = await runtime.useModel(ModelType.TRANSCRIPTION, buffer);
		} catch (err) {
			// error-policy:J4 the attachment stays readable-as-absent and the
			// caller's fallback message reports the state honestly. Only a
			// no-provider-can-serve failure marks the record unavailable; transient
			// provider errors leave it retryable. Expected when STT is disabled, so
			// debug, not warn.
			if (isTranscriptionUnavailableError(err)) {
				attachment.notProcessed = `Transcription unavailable: ${err.message}`;
			} else {
				delete attachment.notProcessed;
			}
			logger.debug(
				{ attachmentId: attachment.id, err },
				"[ReadAttachment] On-demand transcription did not produce a transcript",
			);
			continue;
		}

		const trimmed = typeof transcript === "string" ? transcript.trim() : "";
		const state: AttachmentTranscriptionState = trimmed
			? { kind: "transcript", text: trimmed }
			: { kind: "empty" };
		await persistAttachmentTranscription(
			runtime,
			record,
			state,
			roomHandlerLease,
		);
	}
}

function titleForRecord(record: AttachmentRecord): string {
	return (
		record.attachment.title?.trim() ||
		record.attachment.url ||
		record.attachment.id
	);
}

function contentForRecords(records: AttachmentRecord[]): string {
	if (records.length === 1) {
		return records[0]?.content.trim() ?? "";
	}
	return records
		.map((record, index) => {
			const content = record.content.trim();
			const title = titleForRecord(record);
			return [
				`Attachment ${index + 1}: ${title}`,
				content || "[No readable content is available for this attachment.]",
			].join("\n");
		})
		.join("\n\n")
		.trim();
}

function hasReadableContent(records: AttachmentRecord[]): boolean {
	return records.some((record) => record.content.trim().length > 0);
}

function attachmentSourceType(
	records: AttachmentRecord[],
): "attachment" | "image_attachment" {
	return records.every(
		(record) => record.attachment.contentType === ContentType.IMAGE,
	)
		? "image_attachment"
		: "attachment";
}

function responseRecordText(params: {
	records: AttachmentRecord[];
	clipboardStatusText: string;
	clipboardResult: Awaited<ReturnType<typeof maybeStoreTaskClipboardItem>>;
	storedContent: string;
}): string {
	const summaries = params.records.map((record) =>
		summarizeAttachment(record.attachment),
	);
	return [
		...summaries,
		params.records.some((record) => record.autoSelected)
			? "Selection: auto-selected because no attachment ID was provided."
			: "",
		params.clipboardStatusText,
		params.clipboardResult.requested && params.clipboardResult.stored
			? `Clipboard usage: ${params.clipboardResult.snapshot.items.length}/${params.clipboardResult.snapshot.maxItems}.`
			: "",
		params.clipboardResult.requested && params.clipboardResult.stored
			? "Clear unused clipboard state when it is no longer needed."
			: "",
		"",
		params.storedContent ||
			"No stored attachment content is available for these attachments.",
	]
		.filter(Boolean)
		.join("\n");
}

async function answerAttachmentRequest(params: {
	runtime: IAgentRuntime;
	message: Memory;
	content: string;
	fallbackText: string;
}): Promise<string> {
	const userRequest =
		typeof params.message.content.text === "string"
			? params.message.content.text.trim()
			: "";
	// A message that is essentially just a URL asks for a short reaction to the
	// page, not a rendition of its full stored content.
	const bareLinkShare = isLinkShareWithoutAsk(userRequest);
	const prompt = [
		"You are answering a user request about an attachment.",
		"Use only the attachment content, extracted text, transcript, or media description below.",
		'Follow explicit formatting instructions from the user, including requests such as "only" or "keep it short".',
		"If the requested answer is not in the attachment content, say that briefly.",
		"Do not include attachment metadata, IDs, source labels, or implementation details.",
		...(bareLinkShare
			? [
					"The user shared a link without asking a question. Reply with ONE short take of at most two sentences on what the page is. Never reproduce the page content.",
				]
			: []),
		"",
		`User request:\n${userRequest || "Read the attachment."}`,
		"",
		`Attachment content:\n${attachmentContentForAnswering(params.content)}`,
	].join("\n");
	const response = await params.runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
		temperature: 0,
		maxTokens: bareLinkShare
			? BARE_LINK_ANSWER_TOKENS
			: attachmentAnswerTokenBudget(params.content),
	});
	const text = String(response).trim();
	// Never fall back to the raw stored content: an empty model response must
	// degrade to a short acknowledgement, not a verbatim page dump.
	return text || params.fallbackText;
}

function getActionParams(
	options: HandlerOptions | undefined,
): Record<string, unknown> {
	const direct =
		options && typeof options === "object"
			? (options as Record<string, unknown>)
			: {};
	const parameters =
		direct.parameters && typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	const actionParameters: Record<string, unknown> = {};
	for (const key of ATTACHMENT_ACTION_PARAMETER_KEYS) {
		if (key in direct) actionParameters[key] = direct[key];
		if (key in parameters) actionParameters[key] = parameters[key];
	}
	return actionParameters;
}

function readAttachmentId(params: Record<string, unknown>): string | null {
	const value = params.attachmentId ?? params.id;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readAttachmentActionKind(
	params: Record<string, unknown>,
): AttachmentAction {
	const raw = params.action ?? params.subaction ?? params.op;
	if (typeof raw === "string") {
		const normalized = raw
			.trim()
			.toLowerCase()
			.replace(/[-\s]+/g, "_");
		if ((ATTACHMENT_ACTIONS as readonly string[]).includes(normalized)) {
			return normalized as AttachmentAction;
		}
	}
	// #10471: no English NL keyword inference — the planner emits the `action`
	// enum (declared in the param schema) for any language. Default to the
	// non-destructive `read`; `save_as_document` is selected via the enum.
	return "read";
}

function readStringParam(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function saveAttachmentAsDocument(params: {
	runtime: IAgentRuntime;
	message: Memory;
	records: AttachmentRecord[];
	content: string;
	actionParams: Record<string, unknown>;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	// suppressPostActionContinuation makes these callbacks the turn's sole
	// delivery — removing them would end the turn silently, so the failure
	// texts stay visible but in voice, marked verified (no turnComplete: the
	// results are failures).
	if (!params.content.trim()) {
		const text = missingReadableContentMessage(params.records);
		await params.callback?.({
			text,
			actions: ["ATTACHMENT_SAVE_AS_DOCUMENT_FAILED"],
			source: params.message.content.source,
		});
		return {
			success: false,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			data: {
				actionName: "ATTACHMENT",
				action: "save_as_document",
				attachmentIds: params.records.map((record) => record.attachment.id),
			},
		};
	}

	const service = params.runtime.getService<DocumentService>(
		DocumentService.serviceType,
	);
	if (!service) {
		const text =
			"I can't save documents right now — document storage isn't available.";
		await params.callback?.({
			text,
			actions: ["ATTACHMENT_SAVE_AS_DOCUMENT_FAILED"],
			source: params.message.content.source,
		});
		return {
			success: false,
			text,
			userFacingText: text,
			verifiedUserFacing: true,
			error: "DOCUMENTS_SERVICE_UNAVAILABLE",
			data: { actionName: "ATTACHMENT", action: "save_as_document" },
		};
	}

	const title =
		readStringParam(params.actionParams, "title") ??
		(params.records.length === 1
			? titleForRecord(params.records[0])
			: deriveDocumentTitle(params.content, "Saved attachments"));
	const filename = createDocumentNoteFilename(title);
	const stored = await service.addDocument({
		agentId: params.runtime.agentId as UUID,
		worldId: (params.message.worldId ?? params.message.roomId) as UUID,
		roomId: params.message.roomId as UUID,
		entityId: params.message.entityId as UUID,
		clientDocumentId: "" as UUID,
		contentType: "text/plain",
		originalFilename: filename,
		content: params.content,
		scope:
			params.actionParams.scope === "owner-private" ||
			params.actionParams.scope === "user-private" ||
			params.actionParams.scope === "agent-private" ||
			params.actionParams.scope === "global"
				? params.actionParams.scope
				: "owner-private",
		addedBy: params.message.entityId as UUID,
		addedByRole: "OWNER",
		addedFrom: "chat",
		metadata: {
			source: "attachment",
			title,
			filename,
			originalFilename: filename,
			fileExt: "txt",
			fileType: "text/plain",
			contentType: "text/plain",
			fileSize: Buffer.byteLength(params.content, "utf8"),
			textBacked: true,
			attachmentIds: params.records.map((record) => record.attachment.id),
			attachmentTitles: params.records.map(titleForRecord),
		},
	});
	// No raw UUID in chat — the document id stays planner-facing in data. The
	// save confirmation is the complete answer to a single-operation turn:
	// verified + turnComplete make it the sole delivery.
	const text = `Saved "${title}" as a document.`;
	await params.callback?.({
		text,
		actions: ["ATTACHMENT_SAVE_AS_DOCUMENT_SUCCESS"],
		source: params.message.content.source,
	});
	return {
		success: true,
		text,
		userFacingText: text,
		verifiedUserFacing: true,
		turnComplete: true,
		data: {
			actionName: "ATTACHMENT",
			action: "save_as_document",
			documentId: stored.clientDocumentId,
			fragmentCount: stored.fragmentCount,
			attachmentIds: params.records.map((record) => record.attachment.id),
		},
	};
}

export const readAttachmentAction: Action = {
	name: "ATTACHMENT",
	contexts: ["general", "files", "media", "messaging", "documents", "web"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"SAVE_ATTACHMENT_AS_DOCUMENT",
		"OPEN_ATTACHMENT",
		"INSPECT_ATTACHMENT",
		"READ_URL",
		"OPEN_URL",
		"READ_WEBPAGE",
	],
	description:
		"Attachment operations. Use action=read to read current or recent attachments/link previews using extracted text, transcripts, page content, or media descriptions. Use action=save_as_document to store readable attachment content in the document store.",
	routingHint:
		"read or save the content of an attachment, link preview, or media ALREADY present in THIS conversation (extracted text/transcript/page/description) -> ATTACHMENT; to fetch a brand-new URL you name yourself -> WEB_FETCH, to manage the agent's stored files -> FILES, or to answer an open-web question -> WEB_SEARCH",
	suppressPostActionContinuation: true,
	validate: async (runtime, message) => {
		const params = message.content as Record<string, unknown>;
		const hasExplicitAttachment =
			readAttachmentId(params) !== null ||
			typeof message.content.attachmentId === "string" ||
			(message.content.attachments?.length ?? 0) > 0;

		const attachments = await listConversationAttachments(runtime, message);
		return hasExplicitAttachment || attachments.length > 0;
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		try {
			const params = getActionParams(options);
			const action = readAttachmentActionKind(params);
			const messageWithParams: Memory = {
				...message,
				content: {
					...message.content,
					...params,
				} as Memory["content"],
			};
			const explicitId =
				readAttachmentId(params) ??
				(typeof message.content.attachmentId === "string"
					? message.content.attachmentId.trim()
					: null);
			const records = await readAttachmentRecords(
				runtime,
				messageWithParams,
				explicitId,
			);
			if (records.length === 0) {
				const attachments = await listConversationAttachments(
					runtime,
					messageWithParams,
				);
				const fallback = attachments.length
					? `Available attachments:\n${attachments.map(summarizeAttachment).join("\n\n")}`
					: "No attachments are available in the current conversation window.";
				if (callback) {
					await callback({
						text: fallback,
						actions: ["ATTACHMENT_READ_FAILED"],
						source: message.content.source,
					});
				}
				// The attachment menu (or "nothing to read") IS the answer the
				// user must act on: verified + turnComplete make it the sole
				// delivery instead of pairing it with a second evaluator reply.
				return {
					success: true,
					text: attachments.length
						? "No attachment matched; showed the user the available attachments to pick from"
						: fallback,
					userFacingText: fallback,
					verifiedUserFacing: true,
					turnComplete: true,
					values: { awaitingSelection: attachments.length > 0 },
					data: { actionName: "ATTACHMENT", action },
				};
			}

			// Every selected media record with no stored transcript gets one live
			// attempt, even when a readable sibling already exists.
			await transcribeMediaOnDemand(
				runtime,
				records,
				options?.roomHandlerLease,
			);
			const hasContent = hasReadableContent(records);
			const storedContent = hasContent ? contentForRecords(records) : "";
			if (action === "save_as_document") {
				return saveAttachmentAsDocument({
					runtime,
					message: messageWithParams,
					records,
					content: storedContent,
					actionParams: params,
					callback,
				});
			}

			const clipboardResult = await maybeStoreTaskClipboardItem(
				runtime,
				messageWithParams,
				{
					fallbackTitle:
						records.length === 1
							? titleForRecord(records[0])
							: `${records.length} attachments`,
					content: storedContent,
					sourceType: attachmentSourceType(records),
					sourceId: records.map((record) => record.attachment.id).join(","),
					sourceLabel: records.map(titleForRecord).join(", "),
					mimeType:
						records.length === 1
							? records[0]?.attachment.contentType
							: undefined,
				},
			);
			let clipboardStatusText = "";
			if (clipboardResult.requested) {
				if (clipboardResult.stored) {
					clipboardStatusText = `${clipboardResult.replaced ? "Updated" : "Added"} clipboard item ${clipboardResult.item.id}: ${clipboardResult.item.title}`;
				} else if ("reason" in clipboardResult) {
					clipboardStatusText = `Clipboard add skipped: ${clipboardResult.reason}`;
				}
			}
			const responseText = responseRecordText({
				records,
				clipboardStatusText,
				clipboardResult,
				storedContent,
			});
			const messageText =
				typeof messageWithParams.content.text === "string"
					? messageWithParams.content.text.trim()
					: "";
			// The record dump (metadata envelope + full stored content) is
			// planner-facing and reaches chat only when the user explicitly asks for
			// it. Keeping clipboard reads on the prose path prevents stored page
			// bodies from becoming accidental chat output; `data` still carries the
			// full content and clipboard state for the planner.
			const visibleText = shouldShowAttachmentRecord(messageText)
				? responseText
				: hasContent
					? await answerAttachmentRequest({
							runtime,
							message: messageWithParams,
							content: storedContent,
							fallbackText:
								records.length === 1
									? `Read "${titleForRecord(records[0])}" but couldn't put an answer together — ask me something specific about it.`
									: "Read the attachments but couldn't put an answer together — ask me something specific about them.",
						})
					: missingReadableContentMessage(records);

			if (callback) {
				await callback({
					text: visibleText,
					actions: ["ATTACHMENT_READ_SUCCESS"],
					source: messageWithParams.content.source,
				});
			}

			// The read answer is the complete answer to a single-operation turn:
			// verified + turnComplete make the callback the sole delivery.
			return {
				success: true,
				text: visibleText,
				userFacingText: visibleText,
				verifiedUserFacing: true,
				turnComplete: true,
				data: {
					actionName: "ATTACHMENT",
					action: "read",
					attachmentId: records[0]?.attachment.id,
					attachmentIds: records.map((record) => record.attachment.id),
					attachment: records[0]?.attachment,
					attachments: records.map((record) => record.attachment),
					content: storedContent,
					contents: records.map((record) => record.content.trim()),
					clipboard: clipboardResult,
					suppressActionResultClipboard: clipboardResult.requested,
				},
			};
		} catch (error) {
			// error-policy:J1 the attachment action boundary returns a structured
			// failure and reports the underlying read error to the agent.
			runtime.reportError("ReadAttachmentAction.handler", error, {
				roomId: message.roomId,
			});
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[ReadAttachment] Error:", errorMessage);
			if (callback) {
				await callback({
					text: "I couldn't read that attachment right now.",
					actions: ["ATTACHMENT_READ_FAILED"],
					source: message.content.source,
				});
			}
			return {
				success: false,
				text: "Failed to read attachment",
				error: errorMessage,
				data: { actionName: "ATTACHMENT" },
			};
		}
	},
	parameters: [
		{
			name: "action",
			description: "Attachment operation: read or save_as_document.",
			required: false,
			schema: { type: "string" as const, enum: [...ATTACHMENT_ACTIONS] },
		},
		{
			name: "attachmentId",
			description:
				"Optional attachment ID to read. Omit to read current or recent attachments.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "addToClipboard",
			description:
				"When true, store the attachment content in bounded task clipboard state.",
			required: false,
			schema: { type: "boolean" as const, default: false },
		},
	],
	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "What does the PDF I just sent you say?",
					source: "chat",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Reading the attachment.",
					actions: ["ATTACHMENT"],
					thought:
						"User refers to a recently-attached file; ATTACHMENT action=read auto-selects the latest attachment when no id is given.",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Open the link I shared above and summarise it.",
					source: "chat",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Reading the page.",
					actions: ["ATTACHMENT"],
					thought:
						"Link previews are stored as attachments; ATTACHMENT action=read pulls the extracted text and answers the user's summary request.",
				},
			},
		],
	],
};

export default readAttachmentAction;
