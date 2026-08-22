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

import { createHash } from "node:crypto";
import { ElizaError } from "../../errors.ts";
import {
	fetchRemoteMedia,
	MediaFetchError,
	readResponseWithLimit,
} from "../../media/fetch.ts";
import {
	linkShareOwnText,
	looksLikeBareLinkShare,
} from "../../services/message/direct-action-heuristics.ts";
import {
	type Action,
	type ActionResult,
	buildContentReference,
	buildReadSlice,
	ContentType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	ModelType,
	type ReadView,
	type State,
	type UUID,
} from "../../types/index.ts";
import { getLocalServerUrl } from "../../utils.ts";
import {
	createDocumentNoteFilename,
	deriveDocumentTitle,
} from "../documents/naming.ts";
import type { DocumentService } from "../documents/service.ts";
import {
	listConversationAttachments,
	readAttachmentRecords,
	summarizeAttachment,
} from "./attachmentContext.ts";
import { maybeStoreTaskClipboardItem } from "./taskClipboardPersistence.ts";

const ATTACHMENT_ACTIONS = ["read", "save_as_document"] as const;
const MIN_ATTACHMENT_ANSWER_TOKENS = 1024;
const MAX_ATTACHMENT_ANSWER_TOKENS = 4096;
/** A bare link share wants a one-to-two sentence reaction, not a page digest. */
const BARE_LINK_ANSWER_TOKENS = 256;
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

export function completeAttachmentContent(content: string): string {
	return content;
}

const ATTACHMENT_READ_TOTAL_PAGE_BYTES = 16 * 1024;
const ATTACHMENT_READ_MAX_ITEM_BYTES = 64 * 1024;

type PagedAttachmentRecord = AttachmentRecord & {
	readView: ReadView;
};

function readNonnegativeInteger(
	params: Record<string, unknown>,
	key: string,
	fallback: number,
	minimum = 0,
): number {
	const value = params[key];
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		throw new ElizaError(`Attachment read ${key} must be a safe integer`, {
			code: "ATTACHMENT_READ_INVALID_RANGE",
			context: { field: key, minimum },
		});
	}
	return value as number;
}

function attachmentRevision(record: AttachmentRecord): string {
	return `attachment:${createHash("sha256")
		.update(record.attachment.id)
		.update("\0")
		.update(record.content)
		.digest("hex")}`;
}

function pageAttachmentRecord(params: {
	record: AttachmentRecord;
	offset: number;
	limit: number;
}): PagedAttachmentRecord {
	const source = Buffer.from(params.record.content, "utf8");
	if (params.offset > source.length) {
		throw new ElizaError("Attachment byte offset exceeds the source", {
			code: "ATTACHMENT_READ_INVALID_OFFSET",
			context: {
				attachmentId: params.record.attachment.id,
				total: source.length,
			},
		});
	}
	const start = params.offset;
	if (start < source.length && (source[start] & 0xc0) === 0x80) {
		throw new ElizaError("Attachment byte offset splits a UTF-8 code point", {
			code: "ATTACHMENT_READ_INVALID_OFFSET",
			context: { attachmentId: params.record.attachment.id, offset: start },
		});
	}
	let end = Math.min(start + params.limit, source.length);
	while (end > start && end < source.length && (source[end] & 0xc0) === 0x80) {
		end -= 1;
	}
	if (end === start && start < source.length) {
		throw new ElizaError(
			"Attachment byte limit is too small for the next UTF-8 code point",
			{
				code: "ATTACHMENT_READ_INVALID_RANGE",
				context: { attachmentId: params.record.attachment.id },
			},
		);
	}
	const page = source.subarray(start, end).toString("utf8");
	const sourceSha256 = createHash("sha256").update(source).digest("hex");
	const revision = attachmentRevision(params.record);
	return {
		...params.record,
		content: page,
		readView: {
			reference: buildContentReference({
				kind: "attachment",
				ref: `attachment:${params.record.attachment.id}`,
				revision,
			}),
			slice: buildReadSlice({
				range: { unit: "byte", start, end, total: source.length },
				completeness: end < source.length ? "partial-recoverable" : "complete",
				revision,
				sliceSha256: createHash("sha256").update(page).digest("hex"),
				sourceSha256,
			}),
		},
	};
}

function pageAttachmentRecords(
	records: AttachmentRecord[],
	params: Record<string, unknown>,
): PagedAttachmentRecord[] {
	const offset = readNonnegativeInteger(params, "offset", 0);
	const requestedLimit = readNonnegativeInteger(params, "limit", 0, 1);
	const fairLimit = Math.max(
		1,
		Math.floor(ATTACHMENT_READ_TOTAL_PAGE_BYTES / Math.max(records.length, 1)),
	);
	const limit = Math.min(
		requestedLimit > 0 ? requestedLimit : fairLimit,
		ATTACHMENT_READ_MAX_ITEM_BYTES,
	);
	if (requestedLimit > ATTACHMENT_READ_MAX_ITEM_BYTES) {
		throw new ElizaError(
			"Attachment read limit exceeds the maximum page size",
			{
				code: "ATTACHMENT_READ_INVALID_RANGE",
				context: { maximum: ATTACHMENT_READ_MAX_ITEM_BYTES },
			},
		);
	}
	return records.map((record) =>
		pageAttachmentRecord({ record, offset, limit }),
	);
}

function projectClipboardResult(
	result: Awaited<ReturnType<typeof maybeStoreTaskClipboardItem>>,
): Record<string, unknown> {
	if (!result.requested || !result.stored) return { ...result };
	return {
		requested: true,
		stored: true,
		replaced: result.replaced,
		item: {
			id: result.item.id,
			title: result.item.title,
			sourceType: result.item.sourceType,
			sourceId: result.item.sourceId,
			createdAt: result.item.createdAt,
			updatedAt: result.item.updatedAt,
		},
		itemCount: result.snapshot.items.length,
	};
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
 * Anchored writer-controlled unavailability marker prefix ("Transcription
 * unavailable:" on-demand, "Audio/Video transcription unavailable:" ingest).
 * The appended error prose can echo a hostile remote body (media/fetch.ts
 * embeds up to ~200 chars of it), so mid-string matches must never count as
 * unavailability evidence. A live re-attempt supersedes ANY stored note,
 * marker or not (transcribeMediaOnDemand): ingest labels every non-fetch
 * provider exception — an ordinary 502 included — with this marker, so a
 * stored marker is history, not proof. By classification time only a record
 * that could not be re-attempted (no url) or one the CURRENT attempt marked
 * unavailable still carries it.
 */
const TRANSCRIPTION_UNAVAILABLE_MARKER =
	/^(?:(?:audio|video)\s+)?transcription unavailable/i;

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
			TRANSCRIPTION_UNAVAILABLE_MARKER.test(record.attachment.notProcessed),
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
		// Honest unavailability beats an open-ended "yet": when no TRANSCRIPTION
		// provider can serve (observed live: cloud STT gated off with no local
		// fallback), "yet" reads as "ask me again later" and the retry dead-ends
		// on the same reply.
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

/** Same cap the ingest path enforces (`ATTACHMENT_FETCH_MAX_BYTES`). */
const ON_DEMAND_TRANSCRIPTION_MAX_BYTES = 50 * 1024 * 1024;
/** Same bound the pre-rework provider-side transcription fetch enforced. */
const ON_DEMAND_TRANSCRIPTION_TIMEOUT_MS = 30_000;
/**
 * The only local shape the content-addressed media store serves
 * (`packages/agent/src/api/media-store.ts`: `MEDIA_URL_PREFIX` + the strict
 * `MEDIA_FILE_NAME` of a 64-hex sha256 and short alphanumeric extension).
 * Anything else must never reach the trusted local fetch.
 */
const LOCAL_MEDIA_STORE_URL = /^\/api\/media\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/;

/**
 * True when a TRANSCRIPTION failure means no provider can serve at all —
 * a provider's *UnavailableError fall-through (e.g. `CloudSttUnavailableError`)
 * or the runtime having no registered handler — as opposed to a transient
 * failure (network blip, provider 5xx) that a later retry could clear. Only
 * the former may claim "speech-to-text isn't enabled" to the user.
 */
function isTranscriptionUnavailableError(err: unknown): err is Error {
	if (!(err instanceof Error)) return false;
	// Fetch-layer failures are NEVER unavailability evidence: MediaFetchError
	// messages embed up to ~200 chars of the REMOTE response body
	// (media/fetch.ts throwIfHttpError), so a hostile host could plant
	// "TRANSCRIPTION not available" prose there and forge the disabled reply.
	// Matched by name rather than instanceof so the exclusion survives module
	// duplication across the multi-target build and test module mocks.
	if (err.name === "MediaFetchError") return false;
	if (err.name.endsWith("UnavailableError")) return true;
	return /falling through to next TRANSCRIPTION handler|no (?:model )?handler.*TRANSCRIPTION|TRANSCRIPTION.*not (?:available|enabled|registered)/i.test(
		err.message,
	);
}

/**
 * Fetches a conversation attachment's bytes for transcription, mirroring the
 * ingest split in `MessageService.fetchAttachmentBytes`: remote
 * (attacker-influenceable) http(s) URLs go through the SSRF-guarded,
 * size-capped, time-bounded media fetch, while local URLs must be exactly the
 * canonical media-store shape (`/api/media/<sha256>.<ext>`) before resolving
 * against the local server with the same size cap and timeout. Anything else
 * is rejected before any fetch: `getLocalServerUrl` is a bare string concat,
 * so an unvalidated `@attacker.example/x` would become
 * `http://localhost:PORT@attacker.example/x` (userinfo trick) and hand the
 * trusted local fetch to an attacker host. Rejections throw transient-class
 * errors with static messages (never echoing the attacker-influenceable url or
 * dynamic response prose) so the reply degrades to the honest "yet" path; the
 * whole local response read (fetch, headers, body) surfaces failures only as
 * typed MediaFetchError, which the unavailability classifier refuses as
 * evidence. The body is read through the shared streaming cap so an absent or
 * lying Content-Length can never force materializing an oversize payload.
 */
async function fetchTranscribableBytes(
	runtime: IAgentRuntime,
	url: string,
): Promise<Buffer> {
	if (/^(http|https):\/\//.test(url)) {
		const { buffer } = await fetchRemoteMedia({
			url,
			maxBytes: ON_DEMAND_TRANSCRIPTION_MAX_BYTES,
			timeoutMs: ON_DEMAND_TRANSCRIPTION_TIMEOUT_MS,
		});
		return buffer;
	}
	if (!LOCAL_MEDIA_STORE_URL.test(url)) {
		throw new Error(
			"Attachment URL is not a canonical media-store path; refusing local fetch",
		);
	}
	// Defence in depth on top of the shape check: the resolved origin must be
	// the local server itself before the trusted fetch runs.
	const localUrl = new URL(getLocalServerUrl(url));
	if (localUrl.hostname !== "localhost" && localUrl.hostname !== "127.0.0.1") {
		throw new Error(
			"Local media fetch resolved to a non-local host; refusing local fetch",
		);
	}
	const runtimeFetch = runtime.fetch ?? globalThis.fetch;
	try {
		const res = await runtimeFetch(localUrl.href, {
			signal: AbortSignal.timeout(ON_DEMAND_TRANSCRIPTION_TIMEOUT_MS),
		});
		if (!res.ok) {
			// Only the numeric status: statusText is dynamic prose and must never
			// feed the unavailability classifier.
			throw new MediaFetchError(
				"http_error",
				`Could not fetch attachment locally (HTTP ${res.status})`,
			);
		}
		// Reject on the declared size BEFORE reading the body (parity with the
		// remote branch's enforceContentLengthLimit in media/fetch.ts); the
		// streamed read below cancels at the cap when the header is absent or
		// lying, so an oversize body is never materialized either way.
		const declaredLength = Number(res.headers.get("content-length"));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > ON_DEMAND_TRANSCRIPTION_MAX_BYTES
		) {
			throw new MediaFetchError(
				"max_bytes",
				`Attachment exceeds ${ON_DEMAND_TRANSCRIPTION_MAX_BYTES} bytes`,
			);
		}
		return await readResponseWithLimit(res, ON_DEMAND_TRANSCRIPTION_MAX_BYTES);
	} catch (err) {
		// error-policy:J2 typed transient-class rethrow covering the WHOLE local
		// response read boundary (fetch, header reads, body read): whatever the
		// fetch or stream layer threw — including a body read rejecting with
		// unavailability-looking prose — the local branch surfaces only
		// MediaFetchError with a static message, which
		// isTranscriptionUnavailableError refuses as STT-disabled evidence.
		// Matched by name rather than instanceof so the pass-through survives
		// module duplication across the multi-target build and test mocks.
		if (err instanceof Error && err.name === "MediaFetchError") throw err;
		throw new MediaFetchError(
			"fetch_failed",
			"Could not fetch attachment locally",
			err,
		);
	}
}

/**
 * Persists a fresh on-demand transcript into the stored message memory that
 * owns the attachment — the same `updateMemory` write ingest performs after
 * `processAttachments` — so later reads answer from storage instead of
 * re-downloading the bytes and re-billing the STT provider. Only the matching
 * attachment entry changes: its stale `notProcessed` marker is dropped, every
 * other stored field survives, and the gathering layer's underscore transport
 * fields never reach storage. Never throws — the in-memory transcript already
 * serves this reply, so a lost write only costs one future re-transcription.
 *
 * Two guards keep this write from destroying stored data: a redacted-disclosure
 * variant (selectAttachmentForRequester keeps the shared `id`/`_messageId` but
 * swaps `url` to the redacted bytes and strips text/description) must never
 * persist its transcript over the original entry, and a stored entry that
 * already carries a non-empty transcript is never overwritten — this fill-only
 * rule also settles concurrent reads racing to persist.
 */
async function persistTranscript(
	runtime: IAgentRuntime,
	record: AttachmentRecord,
	transcript: string,
): Promise<void> {
	const { attachment } = record;
	const messageId = attachment._messageId;
	// Without a known owning row (e.g. an unsaved in-flight message) there is
	// nothing to update; the next read simply retries transcription.
	if (!messageId) return;
	// A redacted variant's transcript came from the redacted bytes; writing it
	// would replace the original entry's real transcript. The in-memory
	// transcript still serves this reply — only the write is skipped.
	if (attachment.redacted) return;
	try {
		const stored = await runtime.getMemoryById(messageId);
		const storedAttachments = stored?.content.attachments;
		if (!stored || !Array.isArray(storedAttachments)) return;
		let found = false;
		const attachments = storedAttachments.map((entry) => {
			if (entry.id !== attachment.id) return entry;
			// Fill-only: an existing stored transcript always wins.
			if (typeof entry.text === "string" && entry.text.trim()) return entry;
			found = true;
			const { notProcessed: _stale, ...rest } = entry;
			return {
				...rest,
				text: transcript,
				description: `Transcript: ${transcript}`,
			};
		});
		if (!found) return;
		const persisted = await runtime.updateMemory({
			id: messageId,
			content: { ...stored.content, attachments },
		});
		if (!persisted) {
			logger.warn(
				{ attachmentId: attachment.id, messageId },
				"[ReadAttachment] updateMemory declined to persist the on-demand transcript",
			);
		}
	} catch (err) {
		// error-policy:J7 persistence is bookkeeping for future reads; its
		// failure must not break the reply the transcript already serves.
		logger.warn(
			{ attachmentId: attachment.id, messageId, err },
			"[ReadAttachment] Failed to persist the on-demand transcript",
		);
		runtime.reportError("ReadAttachmentAction.persistTranscript", err, {
			attachmentId: attachment.id,
			messageId,
		});
	}
}

/**
 * Live retry for media records whose ingest-time transcription produced
 * nothing (observed live: a video posted while cloud STT was gated off has no
 * transcript, and every later "can you get one?" dead-ended on the canned
 * missing-transcript reply even after STT came back). Fetches the stored
 * attachment bytes with ingest's remote/local split — conversation media the
 * ingest path already fetched once, not a new URL from chat text (that still
 * routes to WEB_FETCH) — and hands the provider a buffer, mirroring the
 * ingest call shape. Success fills the record in place so read/save answer
 * from the fresh transcript and persists it to the owning message so later
 * reads stop re-billing STT. The CURRENT attempt is authoritative over any
 * stored notProcessed note: only a typed-unavailable failure from THIS
 * attempt marks the record unavailable, while a transient failure (remote or
 * local fetch, provider blip) or an empty transcript leaves it note-free so
 * the user-facing reply stays the honest open-ended "yet".
 */
async function transcribeMediaOnDemand(
	runtime: IAgentRuntime,
	records: AttachmentRecord[],
): Promise<boolean> {
	let transcribedAny = false;
	for (const record of records) {
		const { attachment } = record;
		if (!isMediaAttachment(record) || record.content.trim()) continue;
		if (typeof attachment.url !== "string" || !attachment.url.trim()) continue;
		// The CURRENT attempt is authoritative: clear ANY prior notProcessed
		// note — anchored unavailability markers included, because ingest writes
		// that marker for every non-fetch provider exception (an ordinary
		// transient 502 among them), so a stored marker is history, not proof.
		// Only this attempt's outcome decides the reply: the catch below
		// re-marks unavailability iff the CURRENT error is typed-unavailable,
		// while success, empty/no-speech, and transient failures leave the
		// record note-free so the reply stays the retryable "yet".
		attachment.notProcessed = undefined;
		try {
			const buffer = await fetchTranscribableBytes(runtime, attachment.url);
			const transcript = await runtime.useModel(
				ModelType.TRANSCRIPTION,
				buffer,
			);
			if (typeof transcript === "string" && transcript.trim()) {
				const text = transcript.trim();
				record.content = text;
				attachment.text = text;
				attachment.description = `Transcript: ${text}`;
				attachment.notProcessed = undefined;
				transcribedAny = true;
				await persistTranscript(runtime, record, text);
			}
		} catch (err) {
			// error-policy:J4 the attachment stays readable-as-absent and the
			// caller's fallback message reports the state honestly. Only a
			// no-provider-can-serve failure from THIS attempt marks the record
			// unavailable (and thus the "isn't enabled" reply); any stored note
			// was cleared before the attempt, so a transient fetch/provider
			// error leaves the record note-free and the reply stays the
			// retryable "yet". Expected whenever STT is disabled, so debug, not
			// warn.
			if (isTranscriptionUnavailableError(err)) {
				attachment.notProcessed = `Transcription unavailable: ${err.message}`;
			}
			logger.debug(
				{ attachmentId: attachment.id, err },
				"[ReadAttachment] On-demand transcription did not produce a transcript",
			);
		}
	}
	return transcribedAny;
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
	// page, not a rendition of it (observed live: a shared link answered with
	// the whole stored page arrived as a ~13-message wall on Discord).
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
		`Attachment content:\n${completeAttachmentContent(params.content)}`,
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
	return { ...direct, ...parameters };
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

	// Type-only DocumentService import + the literal service type keep the
	// fs/parser-heavy service module out of this action's bundle graph.
	const service = params.runtime.getService<DocumentService>("documents");
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
	// Resolve worldId from the message or its room. Falling back to roomId
	// mixes namespaces and corrupts world-scoped document isolation — world
	// operations must use worldId, never roomId (see secret-context invariant
	// and attachment-knowledge-ingest's room lookup pattern).
	let resolvedWorldId = params.message.worldId as UUID | undefined;
	if (!resolvedWorldId) {
		let room: Awaited<ReturnType<IAgentRuntime["getRoom"]>>;
		try {
			room = await params.runtime.getRoom(params.message.roomId as UUID);
		} catch (err) {
			// error-policy:J2 world scoping is required for document isolation; fabricating
			// a worldId from the roomId would hide a broken data path.
			throw new ElizaError("attachment→document world resolution failed", {
				code: "ATTACHMENT_DOCUMENT_WORLD_LOOKUP_FAILED",
				cause: err instanceof Error ? err : new Error(String(err)),
				severity: "ephemeral",
				context: { roomId: params.message.roomId },
			});
		}
		if (!room) {
			throw new ElizaError("attachment→document room was not found", {
				code: "ATTACHMENT_DOCUMENT_ROOM_NOT_FOUND",
				severity: "ephemeral",
				context: { roomId: params.message.roomId },
			});
		}
		resolvedWorldId = (room.worldId ?? params.runtime.agentId) as UUID;
	}
	const stored = await service.addDocument({
		agentId: params.runtime.agentId as UUID,
		worldId: resolvedWorldId,
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
		_options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		try {
			const params = getActionParams(_options);
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
				const fallback = explicitId
					? "That attachment is unavailable or no longer authorized."
					: attachments.length
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
					success: !explicitId,
					text: attachments.length
						? "No attachment matched; showed the user the available attachments to pick from"
						: fallback,
					...(explicitId
						? { error: "ATTACHMENT_UNAVAILABLE_OR_UNAUTHORIZED" }
						: {}),
					userFacingText: fallback,
					verifiedUserFacing: true,
					turnComplete: true,
					values: {
						awaitingSelection: !explicitId && attachments.length > 0,
					},
					data: {
						actionName: "ATTACHMENT",
						action,
						...(explicitId ? { error: "unavailable_or_unauthorized" } : {}),
					},
				};
			}

			if (action === "read" && records.length > 1 && !explicitId) {
				const candidates = records.map((record) => ({
					id: record.attachment.id,
					title: titleForRecord(record),
					contentType: record.attachment.contentType,
					source: record.attachment.source,
					readableBytes: Buffer.byteLength(record.content, "utf8"),
				}));
				const text = [
					"Multiple attachments are available. Select one attachment ID to read an exact page:",
					...candidates.map(
						(candidate) =>
							`- ${candidate.title} (${candidate.id}, ${candidate.contentType ?? "unknown"}, ${candidate.readableBytes} readable bytes)`,
					),
				].join("\n");
				await callback?.({
					text,
					actions: ["ATTACHMENT_READ_SELECTION_REQUIRED"],
					source: messageWithParams.content.source,
				});
				return {
					success: true,
					text,
					userFacingText: text,
					verifiedUserFacing: true,
					turnComplete: true,
					values: { awaitingSelection: true },
					data: {
						actionName: "ATTACHMENT",
						action: "read",
						requiresAttachmentSelection: true,
						attachments: candidates,
					},
					promptData: {
						actionName: "ATTACHMENT",
						action: "read",
						requiresAttachmentSelection: true,
						attachments: candidates,
					},
				};
			}

			let hasContent = hasReadableContent(records);
			// Media with no stored transcript gets one live attempt before the
			// missing-content fallback, covering both read and save_as_document.
			if (!hasContent && (await transcribeMediaOnDemand(runtime, records))) {
				hasContent = hasReadableContent(records);
			}
			const completeStoredContent = hasContent
				? contentForRecords(records)
				: "";
			if (action === "save_as_document") {
				return await saveAttachmentAsDocument({
					runtime,
					message: messageWithParams,
					records,
					content: completeStoredContent,
					actionParams: params,
					callback,
				});
			}

			const pagedRecords = pageAttachmentRecords(records, params);
			const expectedRevision = readStringParam(params, "expectedRevision");
			if (
				pagedRecords.some((record) => record.readView.slice.range.start > 0) &&
				!expectedRevision
			) {
				return {
					success: false,
					text: "An attachment revision is required to continue reading.",
					error: "ATTACHMENT_READ_EXPECTED_REVISION_REQUIRED",
					data: {
						actionName: "ATTACHMENT",
						action: "read",
						error: "expected_revision_required",
					},
					promptData: {
						actionName: "ATTACHMENT",
						action: "read",
						error: "expected_revision_required",
					},
				};
			}
			if (
				expectedRevision &&
				(pagedRecords.length !== 1 ||
					expectedRevision !== pagedRecords[0]?.readView.slice.revision)
			) {
				return {
					success: false,
					text: "The attachment changed before this page could be read.",
					error: "ATTACHMENT_READ_STALE_REVISION",
					data: {
						actionName: "ATTACHMENT",
						action: "read",
						error: "stale_revision",
						readView: pagedRecords[0]?.readView,
					},
					promptData: {
						actionName: "ATTACHMENT",
						action: "read",
						error: "stale_revision",
						readView: pagedRecords[0]?.readView,
					},
				};
			}
			const storedContent = hasContent ? contentForRecords(pagedRecords) : "";
			const exactPageText = hasContent
				? pagedRecords.map((record) => record.content).join("")
				: "";

			const clipboardResult = await maybeStoreTaskClipboardItem(
				runtime,
				messageWithParams,
				{
					fallbackTitle:
						pagedRecords.length === 1
							? titleForRecord(pagedRecords[0])
							: `${pagedRecords.length} attachments`,
					content: storedContent,
					sourceType: attachmentSourceType(records),
					sourceId: pagedRecords
						.map((record) => record.attachment.id)
						.join(","),
					sourceLabel: pagedRecords.map(titleForRecord).join(", "),
					mimeType:
						pagedRecords.length === 1
							? pagedRecords[0]?.attachment.contentType
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
				records: pagedRecords,
				clipboardStatusText,
				clipboardResult,
				storedContent,
			});
			const messageText =
				typeof messageWithParams.content.text === "string"
					? messageWithParams.content.text.trim()
					: "";
			// The record dump (metadata envelope + full stored content) is
			// planner-facing and reaches chat only when the user explicitly asked
			// for the attachment record. Every other read answers in prose —
			// observed live: a clipboard-requested read of a shared link switched
			// delivery to the record dump and shipped the whole scraped page
			// verbatim to Discord. The planner still gets the full content and
			// clipboard state through `data`.
			const visibleText = shouldShowAttachmentRecord(messageText)
				? responseText
				: hasContent
					? await answerAttachmentRequest({
							runtime,
							message: messageWithParams,
							content: storedContent,
							fallbackText:
								pagedRecords.length === 1
									? `Read "${titleForRecord(pagedRecords[0])}" but couldn't put an answer together — ask me something specific about it.`
									: "Read the attachments but couldn't put an answer together — ask me something specific about them.",
						})
					: missingReadableContentMessage(pagedRecords);

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
				// A paging call selects exactly one attachment, so this string is the
				// canonical source page named by the single ReadView. Display labels
				// stay only in the action's private answer-model prompt.
				text: exactPageText,
				transcriptVisibility: "internal",
				userFacingText: visibleText,
				verifiedUserFacing: true,
				turnComplete: true,
				data: {
					actionName: "ATTACHMENT",
					action: "read",
					attachmentId: pagedRecords[0]?.attachment.id,
					attachmentIds: pagedRecords.map((record) => record.attachment.id),
					attachments: pagedRecords.map((record) => ({
						id: record.attachment.id,
						title: record.attachment.title,
						contentType: record.attachment.contentType,
						source: record.attachment.source,
						notProcessed: record.attachment.notProcessed,
					})),
					readView: pagedRecords[0]?.readView,
					clipboard: projectClipboardResult(clipboardResult),
					suppressActionResultClipboard: clipboardResult.requested,
				},
				promptData: {
					actionName: "ATTACHMENT",
					action: "read",
					attachmentIds: pagedRecords.map((record) => record.attachment.id),
					readView: pagedRecords[0]?.readView,
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
			name: "offset",
			description: "Zero-based UTF-8 byte offset for an attachment read page.",
			required: false,
			schema: { type: "number" as const, minimum: 0 },
		},
		{
			name: "limit",
			description:
				"Maximum UTF-8 bytes per selected attachment. Multiple attachments each receive the same fair page allowance.",
			required: false,
			schema: {
				type: "number" as const,
				minimum: 1,
				maximum: ATTACHMENT_READ_MAX_ITEM_BYTES,
			},
		},
		{
			name: "expectedRevision",
			description:
				"Revision from a preceding single-attachment page. A changed or revoked source fails explicitly.",
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
