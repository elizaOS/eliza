/**
 * Shared parameter parsers for triage actions.
 *
 * Agents pass parameters via HandlerOptions.parameters (structured) or may
 * leave them unset, in which case the action falls back to a minimal
 * default. We validate presence + shape here and emit strong-typed inputs
 * so the handlers themselves stay flat.
 */

import type { HandlerOptions } from "../../../../types/index.ts";
import { ALL_MESSAGE_SOURCES, type MessageSource } from "../types.ts";

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

function asSourceList(value: unknown): MessageSource[] | undefined {
	const candidates: unknown[] = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	if (candidates.length === 0) return undefined;
	const out: MessageSource[] = [];
	for (const c of candidates) {
		const s = asString(c);
		if (!s) continue;
		const lower = s.toLowerCase();
		if ((ALL_MESSAGE_SOURCES as readonly string[]).includes(lower)) {
			out.push(lower as MessageSource);
		}
	}
	return out.length > 0 ? out : undefined;
}

export interface TriageParams {
	sources?: MessageSource[];
	sinceMs?: number;
	limit?: number;
}
export function parseTriageParams(
	options: HandlerOptions | undefined,
): TriageParams {
	const params = getParams(options);
	return {
		sources: asSourceList(params.sources),
		sinceMs: asNumber(params.sinceMs),
		limit: asNumber(params.limit),
	};
}

export interface ListInboxParams {
	sources?: MessageSource[];
	limit?: number;
	sinceMs?: number;
}
export function parseListInboxParams(
	options: HandlerOptions | undefined,
): ListInboxParams {
	const params = getParams(options);
	return {
		sources: asSourceList(params.sources),
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
