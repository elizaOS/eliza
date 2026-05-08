// Deprecated LifeOps fallback shim. Canonical iMessage messaging should go
// through @elizaos/plugin-imessage runtime services; this bridge remains for
// legacy BlueBubbles/imsg backends when the native plugin is unavailable.
/**
 * iMessage bridge — dual-backend (`imsg` CLI or BlueBubbles HTTP API).
 *
 * Backend detection is lazy and cached per-config key. No network or
 * subprocess work happens at import time.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IMessageBackend = "imsg" | "bluebubbles" | "none";

export interface IMessageBridgeConfig {
  preferredBackend?: IMessageBackend;
  bluebubblesUrl?: string;
  bluebubblesPassword?: string;
  imsgPath?: string;
}

export interface IMessageSendRequest {
  to: string;
  text: string;
  attachmentPaths?: string[];
}

export interface IMessageRecord {
  id: string;
  fromHandle: string;
  toHandles: string[];
  text: string;
  isFromMe: boolean;
  sentAt: string;
  chatId?: string;
  attachments?: Array<{ name: string; mimeType?: string; path?: string }>;
}

export interface IMessageChat {
  id: string;
  name: string;
  participants: string[];
  lastMessageAt?: string;
}

export interface IMessageBackendStatus {
  backend: IMessageBackend;
  accountHandle: string | null;
  sendMode: "cli" | "private-api" | "apple-script" | "none";
  helperConnected: boolean | null;
  privateApiEnabled: boolean | null;
  diagnostics: string[];
}

export class IMessageBridgeError extends Error {
  readonly backend: IMessageBackend;
  readonly cause?: unknown;

  constructor(message: string, backend: IMessageBackend, cause?: unknown) {
    super(message);
    this.name = "IMessageBridgeError";
    this.backend = backend;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Detection cache
// ---------------------------------------------------------------------------

const detectionCache = new Map<string, IMessageBackend>();

function cacheKey(config?: IMessageBridgeConfig): string {
  const c = config ?? {};
  return [
    c.preferredBackend ?? "",
    c.bluebubblesUrl ?? "",
    c.imsgPath ?? "",
  ].join("|");
}

function resolveImsgBinary(config?: IMessageBridgeConfig): string {
  return config?.imsgPath?.trim() || "imsg";
}

async function probeImsg(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ["--version"], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function probeBlueBubbles(
  url: string,
  password?: string,
): Promise<boolean> {
  try {
    const target = new URL("/api/v1/server/info", url);
    const response = await fetch(target.toString(), {
      method: "GET",
      headers: bluebubblesAuthHeaders(password),
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Build BlueBubbles auth headers. BlueBubbles' v1 API accepts the server
 * password via either a `password` query parameter or an `Authorization:
 * Bearer <password>` header; we always use the header form so the credential
 * never lands in URL access logs, browser history, or referrer headers.
 */
function bluebubblesAuthHeaders(password?: string): Record<string, string> {
  if (!password) return {};
  return { Authorization: `Bearer ${password}` };
}

export async function detectIMessageBackend(
  config?: IMessageBridgeConfig,
): Promise<IMessageBackend> {
  const key = cacheKey(config);
  const cached = detectionCache.get(key);
  if (cached !== undefined && cached !== "none") return cached;

  const preferred = config?.preferredBackend;
  if (preferred === "none") {
    detectionCache.set(key, "none");
    return "none";
  }

  if (preferred === "imsg") {
    const ok = await probeImsg(resolveImsgBinary(config));
    const result: IMessageBackend = ok ? "imsg" : "none";
    detectionCache.set(key, result);
    return result;
  }

  if (preferred === "bluebubbles") {
    if (!config?.bluebubblesUrl) {
      detectionCache.set(key, "none");
      return "none";
    }
    const ok = await probeBlueBubbles(
      config.bluebubblesUrl,
      config.bluebubblesPassword,
    );
    const result: IMessageBackend = ok ? "bluebubbles" : "none";
    detectionCache.set(key, result);
    return result;
  }

  // Auto-detect: try imsg first, then BlueBubbles.
  if (await probeImsg(resolveImsgBinary(config))) {
    detectionCache.set(key, "imsg");
    return "imsg";
  }

  if (
    config?.bluebubblesUrl &&
    (await probeBlueBubbles(config.bluebubblesUrl, config.bluebubblesPassword))
  ) {
    detectionCache.set(key, "bluebubbles");
    return "bluebubbles";
  }

  detectionCache.set(key, "none");
  return "none";
}

/** Clear the backend detection cache. Mostly useful for tests. */
export function clearIMessageBackendCache(): void {
  detectionCache.clear();
}

export async function getIMessageBackendStatus(
  config?: IMessageBridgeConfig,
): Promise<IMessageBackendStatus> {
  const backend = await detectIMessageBackend(config);
  if (backend === "none") {
    return {
      backend,
      accountHandle: null,
      sendMode: "none",
      helperConnected: null,
      privateApiEnabled: null,
      diagnostics: ["no_backend_available"],
    };
  }

  if (backend === "imsg") {
    return {
      backend,
      accountHandle: null,
      sendMode: "cli",
      helperConnected: null,
      privateApiEnabled: null,
      diagnostics: [],
    };
  }

  const info = await getBlueBubblesServerInfo(config ?? {});
  const diagnostics: string[] = [];
  const sendMode = deriveBlueBubblesSendMode(info);
  if (!info.private_api) {
    diagnostics.push("bluebubbles_private_api_disabled");
  }
  if (info.private_api && !info.helper_connected) {
    diagnostics.push("bluebubbles_helper_disconnected");
  }

  return {
    backend,
    accountHandle: info.detected_imessage ?? info.detected_icloud ?? null,
    sendMode,
    helperConnected:
      typeof info.helper_connected === "boolean" ? info.helper_connected : null,
    privateApiEnabled:
      typeof info.private_api === "boolean" ? info.private_api : null,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// imsg CLI backend
// ---------------------------------------------------------------------------

interface ImsgChatJson {
  id?: string;
  guid?: string;
  name?: string;
  displayName?: string;
  participants?: string[];
  lastMessageAt?: string;
}

interface ImsgMessageJson {
  id?: string;
  guid?: string;
  from?: string;
  fromHandle?: string;
  to?: string[];
  toHandles?: string[];
  text?: string;
  body?: string;
  isFromMe?: boolean;
  sentAt?: string;
  date?: string;
  chatId?: string;
  chatGuid?: string;
  attachments?: Array<{ name?: string; mimeType?: string; path?: string }>;
}

async function runImsg(binary: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new IMessageBridgeError(
      `imsg ${args[0] ?? ""} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "imsg",
      error,
    );
  }
}

function parseImsgJson<T>(stdout: string, op: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new IMessageBridgeError(`imsg ${op} produced empty output`, "imsg");
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new IMessageBridgeError(
      `imsg ${op} produced invalid JSON`,
      "imsg",
      error,
    );
  }
}

function normalizeImsgChat(raw: ImsgChatJson): IMessageChat {
  const id = raw.id ?? raw.guid ?? "";
  if (!id) {
    throw new IMessageBridgeError("imsg chat missing id/guid", "imsg");
  }
  return {
    id,
    name: raw.name ?? raw.displayName ?? id,
    participants: Array.isArray(raw.participants) ? raw.participants : [],
    lastMessageAt: raw.lastMessageAt,
  };
}

function normalizeImsgMessage(raw: ImsgMessageJson): IMessageRecord {
  const id = raw.id ?? raw.guid ?? "";
  if (!id) {
    throw new IMessageBridgeError("imsg message missing id/guid", "imsg");
  }
  const sentAt = raw.sentAt ?? raw.date ?? new Date().toISOString();
  return {
    id,
    fromHandle: raw.fromHandle ?? raw.from ?? "",
    toHandles: raw.toHandles ?? raw.to ?? [],
    text: raw.text ?? raw.body ?? "",
    isFromMe: Boolean(raw.isFromMe),
    sentAt,
    chatId: raw.chatId ?? raw.chatGuid,
    attachments: raw.attachments?.map((a) => ({
      name: a.name ?? "",
      mimeType: a.mimeType,
      path: a.path,
    })),
  };
}

async function sendViaImsg(
  req: IMessageSendRequest,
  config?: IMessageBridgeConfig,
): Promise<{ ok: true; messageId?: string }> {
  const binary = resolveImsgBinary(config);
  const args = ["send", req.to, req.text];
  for (const path of req.attachmentPaths ?? []) {
    args.push("--attachment", path);
  }
  args.push("--json");

  const stdout = await runImsg(binary, args);
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: true };
  }
  const parsed = parseImsgJson<{ id?: string; messageId?: string }>(
    trimmed,
    "send",
  );
  return { ok: true, messageId: parsed.messageId ?? parsed.id };
}

async function readViaImsg(
  opts: { chatId?: string; since?: string; limit?: number },
  config?: IMessageBridgeConfig,
): Promise<IMessageRecord[]> {
  const binary = resolveImsgBinary(config);
  const args = ["read", "--json"];
  if (opts.chatId) args.push("--chat", opts.chatId);
  if (opts.since) args.push("--since", opts.since);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));

  const stdout = await runImsg(binary, args);
  const parsed = parseImsgJson<ImsgMessageJson[]>(stdout, "read");
  if (!Array.isArray(parsed)) {
    throw new IMessageBridgeError("imsg read expected JSON array", "imsg");
  }
  return parsed.map(normalizeImsgMessage);
}

async function listChatsViaImsg(
  config?: IMessageBridgeConfig,
): Promise<IMessageChat[]> {
  const binary = resolveImsgBinary(config);
  const stdout = await runImsg(binary, ["chats", "--json"]);
  const parsed = parseImsgJson<ImsgChatJson[]>(stdout, "chats");
  if (!Array.isArray(parsed)) {
    throw new IMessageBridgeError("imsg chats expected JSON array", "imsg");
  }
  return parsed.map(normalizeImsgChat);
}

// ---------------------------------------------------------------------------
// BlueBubbles HTTP API backend
// ---------------------------------------------------------------------------

interface BlueBubblesResponse<T> {
  status: number;
  message?: string;
  data?: T;
}

interface BlueBubblesServerInfo {
  private_api?: boolean;
  helper_connected?: boolean;
  detected_imessage?: string | null;
  detected_icloud?: string | null;
}

function deriveBlueBubblesSendMode(
  info: BlueBubblesServerInfo,
): "private-api" | "apple-script" {
  return info.private_api && info.helper_connected
    ? "private-api"
    : "apple-script";
}

interface BlueBubblesChat {
  guid: string;
  displayName?: string | null;
  chatIdentifier?: string;
  participants?: Array<{ address?: string; handle?: string }>;
  lastMessage?: { dateCreated?: number };
  lastMessageAt?: number;
}

interface BlueBubblesAttachment {
  guid?: string;
  transferName?: string;
  mimeType?: string;
  originalROI?: string;
}

interface BlueBubblesMessage {
  guid: string;
  text?: string | null;
  handle?: { address?: string } | null;
  chatGuid?: string;
  chats?: Array<{ guid: string }>;
  isFromMe?: boolean;
  dateCreated?: number;
  attachments?: BlueBubblesAttachment[];
}

function directRecipientFromBlueBubblesChatGuid(
  chatGuid: string | undefined,
): string | undefined {
  const directPrefix = ";-;";
  const directMarkerIndex = chatGuid?.indexOf(directPrefix) ?? -1;
  if (!chatGuid || directMarkerIndex < 0) {
    return undefined;
  }
  const recipient = chatGuid.slice(directMarkerIndex + directPrefix.length);
  return recipient.trim().length > 0 ? recipient : undefined;
}

function buildBlueBubblesUrl(
  config: IMessageBridgeConfig,
  pathname: string,
  search?: Record<string, string>,
): URL {
  if (!config.bluebubblesUrl) {
    throw new IMessageBridgeError(
      "BlueBubbles URL not configured",
      "bluebubbles",
    );
  }
  const url = new URL(pathname, config.bluebubblesUrl);
  if (search) {
    for (const [k, v] of Object.entries(search)) {
      url.searchParams.set(k, v);
    }
  }
  return url;
}

async function bluebubblesRequest<T>(
  config: IMessageBridgeConfig,
  pathname: string,
  init: RequestInit & { search?: Record<string, string> } = {},
): Promise<T> {
  const { search, headers, ...requestInit } = init;
  const url = buildBlueBubblesUrl(config, pathname, search);
  const mergedHeaders: Record<string, string> = {
    ...bluebubblesAuthHeaders(config.bluebubblesPassword),
    ...((headers as Record<string, string>) ?? {}),
  };

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      ...requestInit,
      headers: mergedHeaders,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new IMessageBridgeError(
      `BlueBubbles request to ${pathname} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "bluebubbles",
      error,
    );
  }

  if (!response.ok) {
    throw new IMessageBridgeError(
      `BlueBubbles ${pathname} returned HTTP ${response.status}`,
      "bluebubbles",
    );
  }

  let body: BlueBubblesResponse<T>;
  try {
    body = (await response.json()) as BlueBubblesResponse<T>;
  } catch (error) {
    throw new IMessageBridgeError(
      `BlueBubbles ${pathname} returned non-JSON body`,
      "bluebubbles",
      error,
    );
  }
  if (!body || typeof body !== "object") {
    throw new IMessageBridgeError(
      `BlueBubbles ${pathname} returned non-JSON body`,
      "bluebubbles",
    );
  }
  if (body.data === undefined) {
    throw new IMessageBridgeError(
      body.message ?? `BlueBubbles ${pathname} missing data`,
      "bluebubbles",
    );
  }
  return body.data;
}

async function getBlueBubblesServerInfo(
  config: IMessageBridgeConfig,
): Promise<BlueBubblesServerInfo> {
  return bluebubblesRequest<BlueBubblesServerInfo>(
    config,
    "/api/v1/server/info",
    { method: "GET" },
  );
}

function normalizeBlueBubblesChat(raw: BlueBubblesChat): IMessageChat {
  return {
    id: raw.guid,
    name: raw.displayName ?? raw.chatIdentifier ?? raw.guid,
    participants:
      raw.participants
        ?.map((p) => p.address ?? p.handle ?? "")
        .filter((v) => v.length > 0) ?? [],
    lastMessageAt:
      typeof raw.lastMessageAt === "number"
        ? new Date(raw.lastMessageAt).toISOString()
        : typeof raw.lastMessage?.dateCreated === "number"
          ? new Date(raw.lastMessage.dateCreated).toISOString()
          : undefined,
  };
}

function normalizeBlueBubblesMessage(raw: BlueBubblesMessage): IMessageRecord {
  const firstChat = raw.chats?.[0];
  const chatId = raw.chatGuid ?? firstChat?.guid;
  const handle = raw.handle?.address?.trim() ?? "";
  const outboundRecipient =
    handle || directRecipientFromBlueBubblesChatGuid(chatId);
  return {
    id: raw.guid,
    fromHandle: raw.isFromMe ? "me" : handle,
    toHandles: raw.isFromMe && outboundRecipient ? [outboundRecipient] : [],
    text: raw.text ?? "",
    isFromMe: Boolean(raw.isFromMe),
    sentAt:
      typeof raw.dateCreated === "number"
        ? new Date(raw.dateCreated).toISOString()
        : new Date().toISOString(),
    chatId,
    attachments: raw.attachments?.map((a) => ({
      name: a.transferName ?? a.guid ?? "",
      mimeType: a.mimeType ?? undefined,
    })),
  };
}

async function sendViaBlueBubbles(
  req: IMessageSendRequest,
  config: IMessageBridgeConfig,
): Promise<{ ok: true; messageId?: string }> {
  const target = await resolveBlueBubblesTarget(req.to, config);
  const info = await getBlueBubblesServerInfo(config);
  const method = deriveBlueBubblesSendMode(info);
  const result = await bluebubblesRequest<BlueBubblesMessage>(
    config,
    "/api/v1/message/text",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatGuid: target,
        message: req.text,
        tempGuid: randomUUID(),
        method,
      }),
    },
  );
  if (!result.guid?.trim()) {
    throw new IMessageBridgeError(
      "BlueBubbles /api/v1/message/text returned message without guid",
      "bluebubbles",
    );
  }
  return { ok: true, messageId: result.guid };
}

async function readViaBlueBubbles(
  opts: { chatId?: string; since?: string; limit?: number },
  config: IMessageBridgeConfig,
): Promise<IMessageRecord[]> {
  const parsedSince = opts.since ? Date.parse(opts.since) : Number.NaN;
  if (opts.since && !Number.isFinite(parsedSince)) {
    throw new IMessageBridgeError(
      `Invalid "since" timestamp: ${opts.since}`,
      "bluebubbles",
    );
  }

  const data = opts.chatId
    ? await bluebubblesRequest<BlueBubblesMessage[]>(
        config,
        `/api/v1/chat/${encodeURIComponent(opts.chatId)}/message`,
        {
          method: "GET",
          search: {
            ...(opts.limit !== undefined ? { limit: String(opts.limit) } : {}),
            offset: "0",
          },
        },
      )
    : await bluebubblesRequest<BlueBubblesMessage[]>(
        config,
        "/api/v1/message/query",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            ...(Number.isFinite(parsedSince) ? { after: parsedSince } : {}),
          }),
        },
      );

  if (!Array.isArray(data)) {
    throw new IMessageBridgeError(
      "BlueBubbles message list was not an array",
      "bluebubbles",
    );
  }
  return data.map(normalizeBlueBubblesMessage);
}

async function listChatsViaBlueBubbles(
  config: IMessageBridgeConfig,
): Promise<IMessageChat[]> {
  const data = await bluebubblesRequest<BlueBubblesChat[]>(
    config,
    "/api/v1/chat/query",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: 100,
        offset: 0,
        with: ["lastMessage", "participants"],
      }),
    },
  );
  if (!Array.isArray(data)) {
    throw new IMessageBridgeError(
      "BlueBubbles chat list was not an array",
      "bluebubbles",
    );
  }
  return data.map(normalizeBlueBubblesChat);
}

async function resolveBlueBubblesTarget(
  target: string,
  config: IMessageBridgeConfig,
): Promise<string> {
  const trimmed = target.trim();
  if (
    trimmed.startsWith("iMessage;") ||
    trimmed.startsWith("SMS;") ||
    trimmed.startsWith("any;")
  ) {
    return trimmed;
  }

  const normalized = trimmed.toLowerCase();
  const chats = await listChatsViaBlueBubbles(config);
  const matchedChat = chats.find(
    (chat) =>
      chat.id.toLowerCase() === normalized ||
      chat.participants.some(
        (participant) => participant.trim().toLowerCase() === normalized,
      ),
  );
  if (matchedChat) {
    return matchedChat.id;
  }

  return `iMessage;-;${trimmed}`;
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

async function resolveActiveBackend(
  config?: IMessageBridgeConfig,
): Promise<IMessageBackend> {
  const backend = await detectIMessageBackend(config);
  if (backend === "none") {
    throw new IMessageBridgeError(
      "No iMessage backend available (imsg binary missing and BlueBubbles unreachable)",
      "none",
    );
  }
  return backend;
}

export async function sendIMessage(
  req: IMessageSendRequest,
  config?: IMessageBridgeConfig,
): Promise<{ ok: true; messageId?: string }> {
  const backend = await resolveActiveBackend(config);
  if (backend === "imsg") {
    return sendViaImsg(req, config);
  }
  return sendViaBlueBubbles(req, config ?? {});
}

export async function readIMessages(
  opts: { chatId?: string; since?: string; limit?: number },
  config?: IMessageBridgeConfig,
): Promise<IMessageRecord[]> {
  const backend = await resolveActiveBackend(config);
  if (backend === "imsg") {
    return readViaImsg(opts, config);
  }
  return readViaBlueBubbles(opts, config ?? {});
}

export async function listIMessageChats(
  config?: IMessageBridgeConfig,
): Promise<IMessageChat[]> {
  const backend = await resolveActiveBackend(config);
  if (backend === "imsg") {
    return listChatsViaImsg(config);
  }
  return listChatsViaBlueBubbles(config ?? {});
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface IMessageSearchOptions {
  query: string;
  chatId?: string;
  limit?: number;
}

/**
 * Search iMessages using the platform's native search API.
 *
 * - `imsg` backend: passes `--search <query>` to the CLI. The CLI queries
 *   the local Messages SQLite database and returns matching records as JSON.
 * - `bluebubbles` backend: POSTs to `/api/v1/message/query` with a `search`
 *   field, which maps to the BlueBubbles full-text search index.
 *
 * No client-side filtering is applied.
 */
export async function searchIMessages(
  opts: IMessageSearchOptions,
  config?: IMessageBridgeConfig,
): Promise<IMessageRecord[]> {
  const backend = await resolveActiveBackend(config);
  if (backend === "imsg") {
    return searchViaImsg(opts, config);
  }
  return searchViaBlueBubbles(opts, config ?? {});
}

async function searchViaImsg(
  opts: IMessageSearchOptions,
  config?: IMessageBridgeConfig,
): Promise<IMessageRecord[]> {
  const binary = resolveImsgBinary(config);
  const args = ["search", "--query", opts.query, "--json"];
  if (opts.chatId) args.push("--chat", opts.chatId);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));

  const stdout = await runImsg(binary, args);
  const parsed = parseImsgJson<ImsgMessageJson[]>(stdout, "search");
  if (!Array.isArray(parsed)) {
    throw new IMessageBridgeError("imsg search expected JSON array", "imsg");
  }
  return parsed.map(normalizeImsgMessage);
}

async function searchViaBlueBubbles(
  opts: IMessageSearchOptions,
  config: IMessageBridgeConfig,
): Promise<IMessageRecord[]> {
  const body: Record<string, unknown> = { search: opts.query };
  if (opts.chatId) body.chatGuid = opts.chatId;
  if (opts.limit !== undefined) body.limit = opts.limit;

  const data = await bluebubblesRequest<BlueBubblesMessage[]>(
    config,
    "/api/v1/message/query",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!Array.isArray(data)) {
    throw new IMessageBridgeError(
      "BlueBubbles message search was not an array",
      "bluebubbles",
    );
  }
  return data.map(normalizeBlueBubblesMessage);
}

// ---------------------------------------------------------------------------
// Read receipts / delivery status
// ---------------------------------------------------------------------------

export type IMessageDeliveryStatus =
  | "delivered_read"
  | "delivered"
  | "sent"
  | "failed"
  | "unknown";

export interface IMessageDeliveryResult {
  messageId: string;
  status: IMessageDeliveryStatus;
  isRead: boolean | null;
  isDelivered: boolean | null;
  errorDescription: string | null;
  checkedAt: string;
}

interface BlueBubblesMessageDetail {
  guid: string;
  isRead?: boolean;
  isDelivered?: boolean;
  error?: number | null;
  errorDescription?: string | null;
}

/**
 * Fetch delivery/read-receipt status for sent iMessages.
 *
 * Only the BlueBubbles backend exposes per-message delivery metadata via
 * `/api/v1/message/:guid`. The imsg CLI has no delivery status command, so
 * that backend returns `"unknown"` for all message IDs.
 */
export async function getIMessageDeliveryStatus(
  messageIds: string[],
  config?: IMessageBridgeConfig,
): Promise<IMessageDeliveryResult[]> {
  const ids = messageIds.filter((id) => id.trim().length > 0);
  if (ids.length === 0) return [];

  const backend = await detectIMessageBackend(config);
  if (backend !== "bluebubbles") {
    return ids.map((id) => ({
      messageId: id,
      status: "unknown" as IMessageDeliveryStatus,
      isRead: null,
      isDelivered: null,
      errorDescription: null,
      checkedAt: new Date().toISOString(),
    }));
  }

  const results: IMessageDeliveryResult[] = [];
  for (const id of ids) {
    const detail = await bluebubblesRequest<BlueBubblesMessageDetail>(
      config ?? {},
      `/api/v1/message/${encodeURIComponent(id)}`,
      { method: "GET" },
    );
    const isRead = typeof detail.isRead === "boolean" ? detail.isRead : null;
    const isDelivered =
      typeof detail.isDelivered === "boolean" ? detail.isDelivered : null;
    let status: IMessageDeliveryStatus;
    if (detail.error) {
      status = "failed";
    } else if (isRead) {
      status = "delivered_read";
    } else if (isDelivered) {
      status = "delivered";
    } else {
      status = "sent";
    }
    results.push({
      messageId: id,
      status,
      isRead,
      isDelivered,
      errorDescription:
        typeof detail.errorDescription === "string"
          ? detail.errorDescription
          : null,
      checkedAt: new Date().toISOString(),
    });
  }
  return results;
}
