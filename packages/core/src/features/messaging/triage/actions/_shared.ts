/**
 * Shared parameter parsers for triage actions.
 *
 * Agents pass parameters via HandlerOptions.parameters (structured) or may
 * leave them unset, in which case the action falls back to a minimal
 * default. We validate presence + shape here and emit strong-typed inputs
 * so the handlers themselves stay flat.
 */

import type { HandlerOptions } from "../../../../types/index.ts";
import {
	ALL_MESSAGE_SOURCES,
	type ManageOperation,
	type MessageSource,
	type SearchMessagesFilters,
} from "../types.ts";

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

function asTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
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
		sources: asSourceList(params.sources),
		worldIds: asStringList(params.worldIds),
		channelIds: asStringList(params.channelIds),
		sinceMs: asNumber(params.sinceMs),
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
		sources: asSourceList(params.sources),
		worldIds: asStringList(params.worldIds),
		channelIds: asStringList(params.channelIds),
		limit: asNumber(params.limit),
		sinceMs: asNumber(params.sinceMs),
	};
}

export interface DraftReplyParams {
	messageId: string;
	body: string;
}
export function parseDraftReplyParams(
	options: HandlerOptions | undefined,
): DraftReplyParams | { error: string } {
	const params = getParams(options);
	const messageId = asString(
		params.messageId ?? params.inReplyToId ?? params.id,
	);
	const body = asString(params.body ?? params.text ?? params.message);
	if (!messageId) return { error: "messageId is required" };
	if (!body) return { error: "body is required" };
	return { messageId, body };
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
	const senderRaw = params.sender;
	let sender: SearchMessagesFilters["sender"];
	if (senderRaw && typeof senderRaw === "object" && !Array.isArray(senderRaw)) {
		const r = senderRaw as Record<string, unknown>;
		sender = {
			identifier: asString(r.identifier ?? r.handle),
			displayName: asString(r.displayName ?? r.name),
		};
	} else if (typeof senderRaw === "string") {
		sender = { identifier: asString(senderRaw) };
	}
	return {
		sources: asSourceList(params.sources),
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
	messageId: string;
	source?: MessageSource;
	operation: ManageOperation;
}
export function parseManageMessageParams(
	options: HandlerOptions | undefined,
): ManageMessageParams | { error: string } {
	const params = getParams(options);
	const messageId = asString(params.messageId ?? params.id);
	if (!messageId) return { error: "messageId is required" };

	const sourceStr = asString(params.source)?.toLowerCase();
	let source: MessageSource | undefined;
	if (sourceStr) {
		if (!(ALL_MESSAGE_SOURCES as readonly string[]).includes(sourceStr)) {
			return { error: `source "${sourceStr}" is not a supported message source` };
		}
		source = sourceStr as MessageSource;
	}

	const opRaw = params.operation ?? params.op;
	let operation: ManageOperation | undefined;
	if (opRaw && typeof opRaw === "object" && !Array.isArray(opRaw)) {
		const r = opRaw as Record<string, unknown>;
		const kind = asString(r.kind)?.toLowerCase();
		operation = parseOperation(kind, r);
	} else if (typeof opRaw === "string") {
		operation = parseOperation(opRaw.toLowerCase(), params);
	}
	if (!operation) {
		return { error: "operation.kind is required (archive|trash|spam|mark_read|label_add|label_remove|tag_add|tag_remove|mute_thread|unsubscribe)" };
	}
	return { messageId, source, operation };
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
	messageId: string;
	body: string;
}
export function parseRespondToMessageParams(
	options: HandlerOptions | undefined,
): RespondToMessageParams | { error: string } {
	const params = getParams(options);
	const messageId = asString(
		params.messageId ?? params.inReplyToId ?? params.id,
	);
	const body = asString(params.body ?? params.text ?? params.message);
	if (!messageId) return { error: "messageId is required" };
	if (!body) return { error: "body is required" };
	return { messageId, body };
}
