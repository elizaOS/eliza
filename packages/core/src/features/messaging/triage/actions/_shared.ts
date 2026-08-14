/**
 * Shared parameter parsers for triage actions.
 *
 * Agents pass parameters via HandlerOptions.parameters (structured) or may
 * leave them unset, in which case the action falls back to a minimal
 * default. We validate presence + shape here and emit strong-typed inputs
 * so the handlers themselves stay flat.
 */

import type {
	ActionParameter,
	AgentContext,
	HandlerOptions,
	Memory,
	State,
} from "../../../../types/index.ts";
import { hasActionContext } from "../../../../utils/action-validation.ts";
import type { MessageSweepReceipt } from "../triage-service.ts";
import {
	ALL_MESSAGE_SOURCES,
	type ManageOperation,
	type MessageSource,
	type SearchMessagesFilters,
} from "../types.ts";

export const MESSAGE_ACTION_CONTEXTS = [
	"messaging",
	"email",
	"contacts",
] satisfies AgentContext[];

export function validateMessageAction(
	message: Memory,
	state: State | undefined,
	contexts: readonly AgentContext[] = MESSAGE_ACTION_CONTEXTS,
): boolean {
	return hasActionContext(message, state, { contexts });
}

/**
 * How the rows in hand were obtained. Coverage is a MEASUREMENT, never an
 * inference from the registry: a registered source may have been skipped or
 * have thrown, and the cached read contacts no source at all.
 */
export type MessageCoverage =
	| { kind: "swept"; receipt: MessageSweepReceipt }
	| { kind: "cache"; sources: readonly MessageSource[] };

/** Everything that can narrow a triage read, as measured at the call site. */
export interface MessageScope {
	/** Sources the planner asked for; absent means every registered source. */
	requestedSources?: readonly MessageSource[];
	/** Sources actually registered with the triage service. */
	registeredSources: readonly MessageSource[];
	/** What was really queried. Omit only when no source read happened. */
	coverage?: MessageCoverage;
	worldIds?: readonly string[];
	channelIds?: readonly string[];
	sender?: SearchMessagesFilters["sender"];
	content?: string;
	tags?: readonly string[];
	sinceMs?: number;
	untilMs?: number;
	limit?: number;
}

/**
 * Describe what a sweep actually reached, from its receipt.
 *
 * Naming the REQUESTED sources (or worse, the registered ones) states that a
 * skipped, unavailable, or failed connector was searched. Only `succeeded`
 * sources were read; everything else is reported as a gap in the same sentence
 * so a partial sweep can never read as a complete one.
 */
function describeSweptCoverage(
	receipt: MessageSweepReceipt,
	registered: number,
): string {
	const gaps: string[] = [];
	if (receipt.unregistered.length > 0) {
		gaps.push(`${receipt.unregistered.join(",")} not connected`);
	}
	if (receipt.unavailable.length > 0) {
		gaps.push(`${receipt.unavailable.join(",")} unavailable`);
	}
	if (receipt.failed.length > 0) {
		gaps.push(`${receipt.failed.map((f) => f.source).join(",")} failed`);
	}
	const gapNote = gaps.length > 0 ? ` — NOT checked: ${gaps.join("; ")}` : "";
	if (receipt.succeeded.length === 0) {
		return `no source was successfully checked${gapNote}`;
	}
	const complete = gaps.length === 0 && receipt.succeeded.length === registered;
	return complete
		? `all ${registered} connected source(s)`
		: `checked=${receipt.succeeded.join(",")} (${receipt.succeeded.length} of ${registered} connected)${gapNote}`;
}

/**
 * Render the scope of a triage read for the result text. An inbox or search
 * result that does not name its own scope asserts full coverage: "no unread
 * messages across connected platforms" while unread mail sits in a source the
 * planner filtered out, or "no matching messages" for a since-window the user
 * never asked for. Filter values supplied as free text (sender, content, tags)
 * are named but never echoed, so a planner blob cannot ride out in the text.
 */
export function describeMessageScope(scope: MessageScope): string {
	const clauses: string[] = [];
	const registered = scope.registeredSources.length;
	if (scope.coverage?.kind === "cache") {
		// The cached read queries nothing. Saying "all N connected source(s)"
		// here presents rows that happen to be in a process-local store as a
		// live sweep of every platform.
		const from = scope.coverage.sources;
		clauses.push(
			from.length > 0
				? `from cached messages only (${from.join(",")}); no source was queried`
				: "from cached messages only; no source was queried",
		);
	} else if (scope.coverage?.kind === "swept") {
		clauses.push(describeSweptCoverage(scope.coverage.receipt, registered));
	} else {
		clauses.push(
			scope.requestedSources && scope.requestedSources.length > 0
				? `sources=${scope.requestedSources.join(",")} (${scope.requestedSources.length} of ${registered} connected)`
				: `all ${registered} connected source(s)`,
		);
	}
	if (scope.worldIds && scope.worldIds.length > 0) {
		clauses.push(`${scope.worldIds.length} account filter(s)`);
	}
	if (scope.channelIds && scope.channelIds.length > 0) {
		clauses.push(`${scope.channelIds.length} channel filter(s)`);
	}
	if (scope.sender) clauses.push("a sender filter");
	if (scope.content) clauses.push("a content keyword");
	if (scope.tags && scope.tags.length > 0) {
		clauses.push(`${scope.tags.length} tag filter(s)`);
	}
	if (typeof scope.sinceMs === "number" && Number.isFinite(scope.sinceMs)) {
		clauses.push(`since ${new Date(scope.sinceMs).toISOString()}`);
	}
	if (typeof scope.untilMs === "number" && Number.isFinite(scope.untilMs)) {
		clauses.push(`until ${new Date(scope.untilMs).toISOString()}`);
	}
	if (typeof scope.limit === "number" && Number.isFinite(scope.limit)) {
		clauses.push(`limit ${scope.limit}`);
	}
	return clauses.join("; ");
}

export const messageSourceParameter: ActionParameter = {
	name: "sources",
	description:
		"Optional message sources to include, such as email, slack, discord, imessage, signal, whatsapp, telegram, or x.",
	required: false,
	schema: {
		type: "array" as const,
		items: { type: "string" as const, enum: [...ALL_MESSAGE_SOURCES] },
	},
};

export const messageIdParameter: ActionParameter = {
	name: "messageId",
	description: "Identifier of the message to act on.",
	required: true,
	schema: { type: "string" as const },
};

export const draftIdParameter: ActionParameter = {
	name: "draftId",
	description: "Identifier of the draft message.",
	required: true,
	schema: { type: "string" as const },
};

export const bodyParameter: ActionParameter = {
	name: "body",
	description: "Message body text.",
	required: true,
	schema: { type: "string" as const },
};

export const limitParameter: ActionParameter = {
	name: "limit",
	description: "Maximum messages to return.",
	required: false,
	schema: { type: "number" as const, minimum: 1, maximum: 100 },
};

export const sinceMsParameter: ActionParameter = {
	name: "sinceMs",
	description: "Only include messages received at or after this timestamp.",
	required: false,
	schema: { type: "number" as const },
};

function getParams(
	options: HandlerOptions | undefined,
): Record<string, unknown> {
	const raw = options?.parameters;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	return {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function asBool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (v === "true") return true;
		if (v === "false") return false;
	}
	return undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function asStringList(value: unknown): string[] | undefined {
	const candidates: unknown[] = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	if (candidates.length === 0) return undefined;
	const out: string[] = [];
	for (const c of candidates) {
		const s = asString(c);
		if (s) out.push(s);
	}
	return out.length > 0 ? out : undefined;
}

function asSourceList(value: unknown): MessageSource[] | undefined {
	const strings = asStringList(value);
	if (!strings) return undefined;
	const out: MessageSource[] = [];
	for (const s of strings) {
		const lower = s.toLowerCase();
		if ((ALL_MESSAGE_SOURCES as readonly string[]).includes(lower)) {
			out.push(lower as MessageSource);
		}
	}
	return out.length > 0 ? out : undefined;
}

function parseSenderParam(
	value: unknown,
): SearchMessagesFilters["sender"] | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const r = value as Record<string, unknown>;
		return {
			identifier: asString(r.identifier ?? r.handle),
			displayName: asString(r.displayName ?? r.name),
		};
	}
	if (typeof value === "string") {
		const sender = asString(value);
		if (!sender) return undefined;
		return sender.includes("@")
			? { identifier: sender }
			: { displayName: sender };
	}
	return undefined;
}

export interface MessageLookupHints {
	sources?: MessageSource[];
	sender?: SearchMessagesFilters["sender"];
	content?: string;
}

function parseMessageLookupHints(
	params: Record<string, unknown>,
): MessageLookupHints {
	return {
		sources: asSourceList(params.sources ?? params.source),
		sender: parseSenderParam(params.sender ?? params.from),
		content: asString(params.content ?? params.query ?? params.q),
	};
}

/**
 * ECMA-262 caps a representable `Date` at ±8.64e15 ms. `Number.isFinite`
 * accepts far larger values, so a schema-valid `"1e100"` parsed to a finite
 * number and then threw `RangeError: Invalid time value` the moment anything
 * formatted it. Reject out-of-range instants HERE rather than at each
 * formatter: a timestamp no `Date` can represent is not a valid timestamp, and
 * one boundary check keeps every consumer safe instead of the one that happened
 * to crash.
 */
const MAX_TIMESTAMP_MS = 8.64e15;

function isRepresentableInstant(value: number): boolean {
	return Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP_MS;
}

function asTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number") {
		return isRepresentableInstant(value) ? value : undefined;
	}
	if (typeof value === "string") {
		const n = Number(value);
		if (Number.isFinite(n)) {
			return isRepresentableInstant(n) ? n : undefined;
		}
		const parsed = Date.parse(value);
		if (isRepresentableInstant(parsed)) return parsed;
	}
	return undefined;
}

export interface TriageParams {
	sources?: MessageSource[];
	worldIds?: string[];
	channelIds?: string[];
	sinceMs?: number;
	limit?: number;
}
export function parseTriageParams(
	options: HandlerOptions | undefined,
): TriageParams {
	const params = getParams(options);
	return {
		sources: asSourceList(params.sources ?? params.source),
		worldIds: asStringList(params.worldIds),
		channelIds: asStringList(params.channelIds),
		sinceMs: asTimestampMs(params.sinceMs),
		limit: asNumber(params.limit),
	};
}

export interface ListInboxParams {
	sources?: MessageSource[];
	worldIds?: string[];
	channelIds?: string[];
	limit?: number;
	sinceMs?: number;
}
export function parseListInboxParams(
	options: HandlerOptions | undefined,
): ListInboxParams {
	const params = getParams(options);
	return {
		sources: asSourceList(params.sources ?? params.source),
		worldIds: asStringList(params.worldIds),
		channelIds: asStringList(params.channelIds),
		limit: asNumber(params.limit),
		sinceMs: asTimestampMs(params.sinceMs),
	};
}

export interface DraftReplyParams {
	messageId?: string;
	body: string;
	lookup: MessageLookupHints;
}

function asReplyBody(params: Record<string, unknown>): string | undefined {
	const body = asString(
		params.body ??
			params.reply ??
			params.replyText ??
			params.text ??
			params.message ??
			params.messageBody,
	);
	if (!body) return undefined;
	if (
		/^\[?\s*(?:please\s+provide|provide|insert|add)\s+(?:the\s+)?(?:reply|message|body|content)/i.test(
			body,
		) ||
		/\b(?:reply|message|body)\s+content\s+(?:here|required|needed)\b/i.test(
			body,
		)
	) {
		return undefined;
	}
	return body
		.replace(
			/\n{0,2}(?:best|regards|sincerely|thanks),?\s*\n\s*\[(?:your\s+name|name|sender)\]\s*$/i,
			"",
		)
		.replace(/\n{0,2}\[(?:your\s+name|name|sender)\]\s*$/i, "")
		.trim();
}

export function parseDraftReplyParams(
	options: HandlerOptions | undefined,
): DraftReplyParams | { error: string } {
	const params = getParams(options);
	const messageId = asString(
		params.messageId ?? params.inReplyToId ?? params.id,
	);
	const body = asReplyBody(params);
	if (!body) return { error: "body is required" };
	return { messageId, body, lookup: parseMessageLookupHints(params) };
}

export interface DraftFollowupParams {
	source: MessageSource;
	to: Array<{ identifier: string; displayName?: string }>;
	body: string;
	subject?: string;
	threadId?: string;
	worldId?: string;
	channelId?: string;
}
export function parseDraftFollowupParams(
	options: HandlerOptions | undefined,
): DraftFollowupParams | { error: string } {
	const params = getParams(options);
	const sourceStr = asString(params.source)?.toLowerCase();
	if (
		!sourceStr ||
		!(ALL_MESSAGE_SOURCES as readonly string[]).includes(sourceStr)
	) {
		return { error: "source must be one of the supported message sources" };
	}
	const source = sourceStr as MessageSource;
	const body = asString(params.body ?? params.text ?? params.message);
	if (!body) return { error: "body is required" };

	let to: DraftFollowupParams["to"] | undefined;
	const rawTo = params.to;
	if (Array.isArray(rawTo)) {
		const list: DraftFollowupParams["to"] = [];
		for (const entry of rawTo) {
			if (typeof entry === "string") {
				const id = entry.trim();
				if (id) list.push({ identifier: id });
			} else if (entry && typeof entry === "object") {
				const record = entry as Record<string, unknown>;
				const identifier = asString(record.identifier ?? record.handle);
				const displayName = asString(record.displayName ?? record.name);
				if (identifier) list.push({ identifier, displayName });
			}
		}
		if (list.length > 0) to = list;
	} else {
		const single = asString(rawTo);
		if (single) to = [{ identifier: single }];
	}
	if (!to || to.length === 0) {
		return { error: "to (at least one recipient) is required" };
	}

	return {
		source,
		to,
		body,
		subject: asString(params.subject),
		threadId: asString(params.threadId),
		worldId: asString(params.worldId),
		channelId: asString(params.channelId),
	};
}

export interface SendDraftParams {
	draftId: string;
	confirmed: boolean;
}
export function parseSendDraftParams(
	options: HandlerOptions | undefined,
): SendDraftParams | { error: string } {
	const params = getParams(options);
	const draftId = asString(params.draftId ?? params.id);
	if (!draftId) return { error: "draftId is required" };
	const confirmed = asBool(params.confirmed) ?? false;
	return { draftId, confirmed };
}

export function parseSearchMessagesParams(
	options: HandlerOptions | undefined,
): SearchMessagesFilters {
	const params = getParams(options);
	const sender = parseSenderParam(params.sender);
	return {
		sources: asSourceList(params.sources ?? params.source),
		worldIds: asStringList(params.worldIds),
		channelIds: asStringList(params.channelIds),
		sender,
		content: asString(params.content ?? params.query ?? params.q),
		tags: asStringList(params.tags),
		sinceMs: asTimestampMs(params.sinceMs ?? params.since),
		untilMs: asTimestampMs(params.untilMs ?? params.until),
		limit: asNumber(params.limit),
	};
}

export interface ManageMessageParams {
	messageId?: string;
	source?: MessageSource;
	operation: ManageOperation;
	lookup: MessageLookupHints;
}
export function parseManageMessageParams(
	options: HandlerOptions | undefined,
): ManageMessageParams | { error: string } {
	const params = getParams(options);
	const messageId = asString(params.messageId ?? params.id);

	const sourceStr = asString(params.source)?.toLowerCase();
	let source: MessageSource | undefined;
	if (sourceStr) {
		if (!(ALL_MESSAGE_SOURCES as readonly string[]).includes(sourceStr)) {
			return {
				error: `source "${sourceStr}" is not a supported message source`,
			};
		}
		source = sourceStr as MessageSource;
	}

	const opRaw =
		params.manageOperation ??
		params.messageOperation ??
		(params.operation === "manage" ? undefined : params.operation) ??
		params.op;
	let operation: ManageOperation | undefined;
	if (opRaw && typeof opRaw === "object" && !Array.isArray(opRaw)) {
		const r = opRaw as Record<string, unknown>;
		const kind = asString(r.kind)?.toLowerCase();
		operation = parseOperation(kind, r);
	} else if (typeof opRaw === "string") {
		operation = parseOperation(opRaw.toLowerCase(), params);
	}
	if (!operation) {
		return {
			error:
				"operation.kind is required (archive|trash|spam|mark_read|label_add|label_remove|tag_add|tag_remove|mute_thread|unsubscribe)",
		};
	}
	return {
		messageId,
		source,
		operation,
		lookup: parseMessageLookupHints(params),
	};
}

function parseOperation(
	kind: string | undefined,
	params: Record<string, unknown>,
): ManageOperation | undefined {
	switch (kind) {
		case "archive":
			return { kind: "archive" };
		case "trash":
			return { kind: "trash" };
		case "spam":
			return { kind: "spam" };
		case "mark_read": {
			const read = asBool(params.read) ?? true;
			return { kind: "mark_read", read };
		}
		case "label_add": {
			const label = asString(params.label);
			if (!label) return undefined;
			return { kind: "label_add", label };
		}
		case "label_remove": {
			const label = asString(params.label);
			if (!label) return undefined;
			return { kind: "label_remove", label };
		}
		case "tag_add": {
			const tag = asString(params.tag);
			if (!tag) return undefined;
			return { kind: "tag_add", tag };
		}
		case "tag_remove": {
			const tag = asString(params.tag);
			if (!tag) return undefined;
			return { kind: "tag_remove", tag };
		}
		case "mute_thread":
			return { kind: "mute_thread" };
		case "unsubscribe":
			return { kind: "unsubscribe" };
		case "block":
		case "block_sender":
			return { kind: "spam" };
		default:
			return undefined;
	}
}

export interface ScheduleDraftSendParams {
	draftId: string;
	sendAtMs: number;
}
export function parseScheduleDraftSendParams(
	options: HandlerOptions | undefined,
): ScheduleDraftSendParams | { error: string } {
	const params = getParams(options);
	const draftId = asString(params.draftId ?? params.id);
	if (!draftId) return { error: "draftId is required" };
	const sendAtMs = asTimestampMs(params.sendAtMs ?? params.sendAt ?? params.at);
	if (sendAtMs === undefined) {
		return { error: "sendAtMs (number) or sendAt (ISO string) is required" };
	}
	return { draftId, sendAtMs };
}

export interface RespondToMessageParams {
	messageId?: string;
	body?: string;
	lookup: MessageLookupHints;
}
export function parseRespondToMessageParams(
	options: HandlerOptions | undefined,
): RespondToMessageParams | { error: string } {
	const params = getParams(options);
	const messageId = asString(
		params.messageId ?? params.inReplyToId ?? params.id,
	);
	const body = asReplyBody(params);
	return { messageId, body, lookup: parseMessageLookupHints(params) };
}
