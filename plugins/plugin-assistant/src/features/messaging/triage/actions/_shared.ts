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
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  hasActionContext,
  resolveScheduledAtIsoInTimeZone,
} from "@elizaos/core";
import type { TriageService } from "../triage-service.ts";
import {
  ALL_MESSAGE_SOURCES,
  MANAGE_OPERATION_KINDS,
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

/** The exact source values the triage adapters accept, for schemas and errors. */
export const SUPPORTED_MESSAGE_SOURCES_TEXT = ALL_MESSAGE_SOURCES.join(", ");

export const messageSourceParameter: ActionParameter = {
  name: "sources",
  description: `Optional message sources to include. One or more of: ${SUPPORTED_MESSAGE_SOURCES_TEXT}. A source with no connected inbox adapter is rejected.`,
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

/**
 * Parse a source filter. An unsupported value is an error, not a dropped
 * filter: dropping it widens the request to every connected source.
 */
function parseSourceList(
  value: unknown,
): { sources: MessageSource[] | undefined } | { error: string } {
  const strings = asStringList(value);
  if (!strings) return { sources: undefined };
  const out: MessageSource[] = [];
  for (const s of strings) {
    const lower = s.toLowerCase();
    if (!(ALL_MESSAGE_SOURCES as readonly string[]).includes(lower)) {
      return {
        error: `source "${lower}" is not a supported message source; use one of: ${SUPPORTED_MESSAGE_SOURCES_TEXT}`,
      };
    }
    out.push(lower as MessageSource);
  }
  return { sources: out };
}

/**
 * An explicitly requested inbox source that cannot be listed is an error.
 * The sweep skips it, so the caller would report an inbox it never read as
 * empty.
 */
export function unlistableSourcesError(
  runtime: IAgentRuntime,
  service: TriageService,
  sources: readonly MessageSource[] | undefined,
): string | undefined {
  if (!sources) return undefined;
  const problems: string[] = [];
  for (const source of sources) {
    const adapter = service.getAdapter(source);
    if (!adapter) {
      problems.push(`${source} (no inbox adapter is connected)`);
    } else if (!adapter.capabilities().list) {
      problems.push(`${source} (its adapter cannot list messages)`);
    } else if (!adapter.isAvailable(runtime)) {
      // An unavailable adapter lists nothing, which reads as an empty inbox.
      problems.push(`${source} (its connector is not connected)`);
    }
  }
  if (problems.length === 0) return undefined;
  const listable = service
    .listAdapters()
    .filter(
      (adapter) => adapter.capabilities().list && adapter.isAvailable(runtime),
    )
    .map((adapter) => adapter.source);
  return `Cannot read the inbox for: ${problems.join(", ")}. Sources that can be read: ${listable.length > 0 ? listable.join(", ") : "none"}.`;
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

/**
 * A lookup with no sender and no content matches the newest message from
 * anyone, so an action that writes to its target must not run on one.
 */
const MESSAGE_TARGET_REQUIRED =
  "messageId or a sender/content hint is required";

function hasLookupTarget(lookup: MessageLookupHints): boolean {
  return (
    lookup.sender?.identifier !== undefined ||
    lookup.sender?.displayName !== undefined ||
    lookup.content !== undefined
  );
}

function parseMessageLookupHints(
  params: Record<string, unknown>,
): MessageLookupHints | { error: string } {
  const parsedSources = parseSourceList(params.sources ?? params.source);
  if ("error" in parsedSources) return parsedSources;
  return {
    sources: parsedSources.sources,
    sender: parseSenderParam(params.sender ?? params.from),
    content: asString(params.content ?? params.query ?? params.q),
  };
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

/**
 * Parse a search window bound. A supplied value that cannot be read is an
 * error, not an absent bound: dropping it searches the whole history.
 */
function parseTimeBound(
  value: unknown,
  field: "since" | "until",
): { ms: number | undefined } | { error: string } {
  if (value === undefined || value === null) return { ms: undefined };
  if (typeof value === "number" && Number.isFinite(value)) return { ms: value };
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) return { ms: undefined };
    // Up to four digits is a calendar year; a longer digit run is epoch ms.
    const ms = /^\d{5,}$/.test(text) ? Number(text) : Date.parse(text);
    if (Number.isFinite(ms)) return { ms };
  }
  return {
    error: `${field} must be an ISO 8601 date or epoch milliseconds`,
  };
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
): TriageParams | { error: string } {
  const params = getParams(options);
  const parsedSources = parseSourceList(params.sources ?? params.source);
  if ("error" in parsedSources) return parsedSources;
  return {
    sources: parsedSources.sources,
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
): ListInboxParams | { error: string } {
  const params = getParams(options);
  const parsedSources = parseSourceList(params.sources ?? params.source);
  if ("error" in parsedSources) return parsedSources;
  return {
    sources: parsedSources.sources,
    worldIds: asStringList(params.worldIds),
    channelIds: asStringList(params.channelIds),
    limit: asNumber(params.limit),
    sinceMs: asNumber(params.sinceMs),
  };
}

export interface DraftReplyParams {
  messageId?: string;
  body: string;
  lookup: MessageLookupHints;
}

const PLACEHOLDER_SIGNATURE_CLOSINGS = new Set([
  "best",
  "regards",
  "sincerely",
  "thanks",
]);

function isPlaceholderSignatureName(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "[name]" || normalized === "[sender]") return true;
  if (!normalized.startsWith("[your") || !normalized.endsWith("name]")) {
    return false;
  }
  let cursor = "[your".length;
  const whitespaceStart = cursor;
  while (cursor < normalized.length && /\s/u.test(normalized[cursor]))
    cursor += 1;
  return cursor > whitespaceStart && normalized.slice(cursor) === "name]";
}

interface PlaceholderSignatureStrip {
  text: string;
  strippedClosing: boolean;
}

function stripPlaceholderSignatureOnce(
  body: string,
  allowClosing: boolean,
): PlaceholderSignatureStrip {
  let end = body.length;
  while (end > 0 && /\s/u.test(body[end - 1])) end -= 1;
  if (body[end - 1] !== "]") return { text: body, strippedClosing: false };
  let open = end - 2;
  while (open >= 0 && body[open] !== "[") open -= 1;
  if (open < 0 || !isPlaceholderSignatureName(body.slice(open, end))) {
    return { text: body, strippedClosing: false };
  }

  let removalStart = open;
  let strippedClosing = false;
  let closingEnd = open;
  let sawNewline = false;
  while (closingEnd > 0 && /\s/u.test(body[closingEnd - 1])) {
    closingEnd -= 1;
    if (body[closingEnd] === "\n") sawNewline = true;
  }
  if (allowClosing && sawNewline) {
    if (body[closingEnd - 1] === ",") closingEnd -= 1;
    for (const closing of PLACEHOLDER_SIGNATURE_CLOSINGS) {
      const closingStart = closingEnd - closing.length;
      if (
        closingStart >= 0 &&
        body.slice(closingStart, closingEnd).toLowerCase() === closing
      ) {
        removalStart = closingStart;
        strippedClosing = true;
        break;
      }
    }
  }
  return { text: body.slice(0, removalStart), strippedClosing };
}

function stripPlaceholderSignature(body: string): string {
  // The replaced regex grammar ran the closing-form strip and then the bare
  // strip in sequence, so removing "Thanks,\n[Your Name]" must still expose
  // and remove one further bare placeholder line beneath it.
  const first = stripPlaceholderSignatureOnce(body, true);
  const text = first.strippedClosing
    ? stripPlaceholderSignatureOnce(first.text, false).text
    : first.text;
  return text.trim();
}

const PLACEHOLDER_REPLY_BODY =
  "body is a placeholder, not reply text; pass the exact reply text in body";

/**
 * A model sometimes fills `body` with a template slot such as
 * "[insert reply here]". Only a body that is one bracketed span is treated as
 * that slot; ordinary text that starts with "Please provide the message..." is
 * a real reply.
 */
function isPlaceholderReplyBody(body: string): boolean {
  if (!/^\[[^[\]]*\]$/.test(body)) return false;
  return (
    /^\[\s*(?:please\s+provide|provide|insert|add)\s+(?:the\s+)?(?:reply|message|body|content)\b/i.test(
      body,
    ) ||
    /\b(?:reply|message|body)\s+content\s+(?:here|required|needed)\b/i.test(
      body,
    )
  );
}

function asReplyBody(
  params: Record<string, unknown>,
): { body: string | undefined } | { error: string } {
  const body = asString(
    params.body ??
      params.reply ??
      params.replyText ??
      params.text ??
      params.message ??
      params.messageBody,
  );
  if (!body) return { body: undefined };
  if (isPlaceholderReplyBody(body)) return { error: PLACEHOLDER_REPLY_BODY };
  const stripped = stripPlaceholderSignature(body);
  if (!stripped) return { error: PLACEHOLDER_REPLY_BODY };
  return { body: stripped };
}

export function parseDraftReplyParams(
  options: HandlerOptions | undefined,
): DraftReplyParams | { error: string } {
  const params = getParams(options);
  const messageId = asString(
    params.messageId ?? params.inReplyToId ?? params.id,
  );
  const reply = asReplyBody(params);
  if ("error" in reply) return reply;
  const body = reply.body;
  if (!body) return { error: "body is required" };
  const lookup = parseMessageLookupHints(params);
  if ("error" in lookup) return lookup;
  if (!messageId && !hasLookupTarget(lookup)) {
    return { error: MESSAGE_TARGET_REQUIRED };
  }
  return { messageId, body, lookup };
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
    return {
      error: `source must be one of: ${SUPPORTED_MESSAGE_SOURCES_TEXT}`,
    };
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
}
export function parseSendDraftParams(
  options: HandlerOptions | undefined,
): SendDraftParams | { error: string } {
  const params = getParams(options);
  const draftId = asString(params.draftId ?? params.id);
  if (!draftId) return { error: "draftId is required" };
  return { draftId };
}

export function parseSearchMessagesParams(
  options: HandlerOptions | undefined,
): SearchMessagesFilters | { error: string } {
  const params = getParams(options);
  const sender = parseSenderParam(params.sender);
  const parsedSources = parseSourceList(params.sources ?? params.source);
  if ("error" in parsedSources) return parsedSources;
  const since = parseTimeBound(params.sinceMs ?? params.since, "since");
  if ("error" in since) return since;
  const until = parseTimeBound(params.untilMs ?? params.until, "until");
  if ("error" in until) return until;
  return {
    sources: parsedSources.sources,
    worldIds: asStringList(params.worldIds),
    channelIds: asStringList(params.channelIds),
    sender,
    content: asString(params.content ?? params.query ?? params.q),
    tags: asStringList(params.tags),
    sinceMs: since.ms,
    untilMs: until.ms,
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
        error: `source "${sourceStr}" is not a supported message source; use one of: ${SUPPORTED_MESSAGE_SOURCES_TEXT}`,
      };
    }
    source = sourceStr as MessageSource;
  }

  const opRaw =
    params.manageOperation ??
    params.messageOperation ??
    (params.operation === "manage" ? undefined : params.operation) ??
    params.op;
  let operation: ManageOperation | { error: string } | undefined;
  if (opRaw && typeof opRaw === "object" && !Array.isArray(opRaw)) {
    const r = opRaw as Record<string, unknown>;
    const kind = asString(r.kind)?.toLowerCase();
    operation = parseOperation(kind, r);
  } else if (typeof opRaw === "string") {
    operation = parseOperation(opRaw.toLowerCase(), params);
  }
  if (!operation) {
    return {
      error: `manageOperation is required (${MANAGE_OPERATION_KINDS.join("|")})`,
    };
  }
  if ("error" in operation) return operation;
  const lookup = parseMessageLookupHints(params);
  if ("error" in lookup) return lookup;
  if (!messageId && !hasLookupTarget(lookup)) {
    return { error: MESSAGE_TARGET_REQUIRED };
  }
  return { messageId, source, operation, lookup };
}

function parseOperation(
  kind: string | undefined,
  params: Record<string, unknown>,
): ManageOperation | { error: string } | undefined {
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
      if (!label) {
        return { error: "label is required for manageOperation=label_add" };
      }
      return { kind: "label_add", label };
    }
    case "label_remove": {
      const label = asString(params.label);
      if (!label) {
        return { error: "label is required for manageOperation=label_remove" };
      }
      return { kind: "label_remove", label };
    }
    case "tag_add": {
      const tag = asString(params.tag);
      if (!tag) {
        return { error: "tag is required for manageOperation=tag_add" };
      }
      return { kind: "tag_add", tag };
    }
    case "tag_remove": {
      const tag = asString(params.tag);
      if (!tag) {
        return { error: "tag is required for manageOperation=tag_remove" };
      }
      return { kind: "tag_remove", tag };
    }
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
  timeZone: string,
): ScheduleDraftSendParams | { error: string } {
  const params = getParams(options);
  const draftId = asString(params.draftId ?? params.id);
  if (!draftId) return { error: "draftId is required" };
  const rawSendAt = params.sendAtMs ?? params.sendAt ?? params.at;
  // The planner writes an offset-free time as a wall clock in the user's
  // zone (CURRENT_TIME's); Date.parse would read it in the host zone.
  const sendAtMs = asTimestampMs(
    typeof rawSendAt === "string"
      ? resolveScheduledAtIsoInTimeZone(rawSendAt, timeZone)
      : rawSendAt,
  );
  if (sendAtMs === undefined) {
    return {
      error:
        "sendAt is required as an ISO 8601 timestamp or epoch milliseconds",
    };
  }
  // A time that is already past is sent on the next scheduler tick, so a
  // misread value (epoch seconds, a bare year, a blank) would send the draft
  // at once while the action reports it as scheduled.
  if (sendAtMs <= Date.now()) {
    return {
      error: `sendAt must be in the future (got ${new Date(sendAtMs).toISOString()})`,
    };
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
  // A supplied body that is refused is an error: dropping it would let the
  // handler queue a generated acknowledgment in place of the dictated reply.
  const reply = asReplyBody(params);
  if ("error" in reply) return reply;
  const lookup = parseMessageLookupHints(params);
  if ("error" in lookup) return lookup;
  if (!messageId && !hasLookupTarget(lookup)) {
    return { error: MESSAGE_TARGET_REQUIRED };
  }
  return { messageId, body: reply.body, lookup };
}
