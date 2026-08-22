/**
 * Implements the production Instagram Graph API boundary for professional
 * accounts. The client owns authentication, transport policy, response
 * validation, pagination, cancellation, and conversion from Graph DTOs into
 * the connector's public domain types.
 */
import { ElizaError } from "@elizaos/core";
import {
  type InstagramMedia,
  InstagramMediaType,
  type InstagramMessage,
  type InstagramThread,
  type InstagramUser,
} from "./types";

const DEFAULT_GRAPH_ORIGIN = "https://graph.instagram.com";
const DEFAULT_GRAPH_VERSION = "v24.0";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 20_000;

export interface InstagramGraphClientConfig {
  accessToken: string;
  instagramAccountId: string;
  graphBaseUrl?: string;
  graphApiVersion?: string;
  requestTimeoutMs?: number;
}

type JsonRecord = Record<string, unknown>;

function graphError(
  message: string,
  code: string,
  context: Record<string, unknown> = {},
  cause?: unknown
): ElizaError {
  return new ElizaError(message, {
    code,
    context,
    ...(cause === undefined ? {} : { cause }),
  });
}

function asRecord(value: unknown, operation: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw graphError(
      "Instagram Graph API returned an invalid response.",
      "INSTAGRAM_GRAPH_INVALID_RESPONSE",
      {
        operation,
        expected: "object",
      }
    );
  }
  return value as JsonRecord;
}

function requiredString(record: JsonRecord, key: string, operation: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw graphError(
      "Instagram Graph API returned an invalid response.",
      "INSTAGRAM_GRAPH_INVALID_RESPONSE",
      {
        operation,
        field: key,
      }
    );
  }
  return value;
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function requiredStringFrom(record: JsonRecord, keys: string[], operation: string): string {
  for (const key of keys) {
    const value = optionalString(record, key);
    if (value) return value;
  }
  throw graphError(
    "Instagram Graph API returned an invalid response.",
    "INSTAGRAM_GRAPH_INVALID_RESPONSE",
    { operation, field: keys.join("|") }
  );
}

function optionalNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalNumberFrom(record: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = optionalNumber(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function boundedJsonShape(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw graphError(
        "Instagram Graph API response exceeded structural limits.",
        "INSTAGRAM_GRAPH_INVALID_RESPONSE"
      );
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else if (current && typeof current === "object") {
      for (const item of Object.values(current as JsonRecord)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

async function readBoundedBody(response: Response, operation: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw graphError(
        "Instagram Graph API response was too large.",
        "INSTAGRAM_GRAPH_INVALID_RESPONSE",
        { operation }
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw graphError(
      "Instagram Graph API response was not valid UTF-8.",
      "INSTAGRAM_GRAPH_INVALID_RESPONSE",
      { operation }
    );
  }
}

function parseGraphDate(value: unknown, operation: string): Date {
  if (typeof value !== "string") {
    throw graphError(
      "Instagram Graph API returned an invalid timestamp.",
      "INSTAGRAM_GRAPH_INVALID_RESPONSE",
      {
        operation,
      }
    );
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw graphError(
      "Instagram Graph API returned an invalid timestamp.",
      "INSTAGRAM_GRAPH_INVALID_RESPONSE",
      {
        operation,
      }
    );
  }
  return date;
}

function normalizeGraphOrigin(raw: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(raw ?? DEFAULT_GRAPH_ORIGIN);
  } catch {
    throw graphError("Instagram Graph API base URL is invalid.", "INSTAGRAM_CONFIG_INVALID");
  }
  const literalLoopback =
    url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && literalLoopback)) {
    throw graphError(
      "Instagram Graph API requires HTTPS (literal loopback HTTP is allowed for tests).",
      "INSTAGRAM_CONFIG_INVALID"
    );
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw graphError(
      "Instagram Graph API base URL must contain only an origin.",
      "INSTAGRAM_CONFIG_INVALID"
    );
  }
  return url;
}

function normalizeVersion(raw: string | undefined): string {
  const version = raw?.trim() || DEFAULT_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) {
    throw graphError("Instagram Graph API version is invalid.", "INSTAGRAM_CONFIG_INVALID");
  }
  return version;
}

function normalizeId(value: string | number, field: string): string {
  const id = String(value).trim();
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(id)) {
    throw graphError(`Instagram ${field} is invalid.`, "INSTAGRAM_INPUT_INVALID", { field });
  }
  return id;
}

function toUser(value: unknown, operation: string): InstagramUser {
  const record = asRecord(value, operation);
  return {
    pk: requiredStringFrom(record, ["id", "user_id"], operation),
    username: optionalString(record, "username") ?? requiredString(record, "name", operation),
    fullName: optionalString(record, "name"),
    profilePicUrl:
      optionalString(record, "profile_pic") ?? optionalString(record, "profile_picture_url"),
    ...(typeof record.is_verified_user === "boolean"
      ? { isVerified: record.is_verified_user }
      : typeof record.is_verified === "boolean"
        ? { isVerified: record.is_verified }
        : {}),
    followerCount: optionalNumberFrom(record, ["follower_count", "followers_count"]),
    followingCount: optionalNumber(record, "follows_count"),
  };
}

function mediaType(value: unknown): InstagramMediaType {
  switch (value) {
    case "IMAGE":
      return InstagramMediaType.PHOTO;
    case "VIDEO":
      return InstagramMediaType.VIDEO;
    case "CAROUSEL_ALBUM":
      return InstagramMediaType.CAROUSEL;
    case "REELS":
      return InstagramMediaType.REEL;
    default:
      throw graphError(
        "Instagram Graph API returned an unsupported media type.",
        "INSTAGRAM_GRAPH_INVALID_RESPONSE",
        { operation: "list-media" }
      );
  }
}

function toMedia(value: unknown, operation: string): InstagramMedia {
  const record = asRecord(value, operation);
  return {
    pk: requiredString(record, "id", operation),
    mediaType: mediaType(record.media_type),
    caption: optionalString(record, "caption"),
    url: optionalString(record, "media_url") ?? optionalString(record, "permalink"),
    thumbnailUrl: optionalString(record, "thumbnail_url"),
    likeCount: optionalNumber(record, "like_count"),
    commentCount: optionalNumber(record, "comments_count"),
    takenAt:
      record.timestamp === undefined ? undefined : parseGraphDate(record.timestamp, operation),
  };
}

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string>;
  body?: JsonRecord | URLSearchParams;
  signal?: AbortSignal;
  ambiguousOnNetworkFailure?: boolean;
}

export class InstagramGraphClient {
  private readonly origin: URL;
  private readonly version: string;
  private readonly accessToken: string;
  private readonly accountId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: InstagramGraphClientConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    this.origin = normalizeGraphOrigin(config.graphBaseUrl);
    this.version = normalizeVersion(config.graphApiVersion);
    this.accessToken = config.accessToken.trim();
    this.accountId = normalizeId(config.instagramAccountId, "account id");
    this.timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;
    if (!this.accessToken || this.accessToken.length > 16_384) {
      throw graphError(
        "Instagram Graph access token is missing or invalid.",
        "INSTAGRAM_CONFIG_INVALID"
      );
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw graphError("Instagram Graph request timeout is invalid.", "INSTAGRAM_CONFIG_INVALID");
    }
  }

  private url(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(`/${this.version}/${path.replace(/^\/+/, "")}`, this.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  private async request(
    path: string,
    operation: string,
    options: RequestOptions = {}
  ): Promise<JsonRecord> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };
    let body: string | undefined;
    if (options.body instanceof URLSearchParams) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = options.body.toString();
    } else if (options.body) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path, options.query), {
        method: options.method ?? "GET",
        headers,
        body,
        redirect: "manual",
        signal,
      });
    } catch (cause) {
      if (signal.aborted) {
        throw graphError(
          "Instagram Graph API request was cancelled or timed out.",
          "INSTAGRAM_GRAPH_CANCELLED",
          {
            operation,
          }
        );
      }
      throw graphError(
        options.ambiguousOnNetworkFailure
          ? "Instagram Graph API write outcome is unknown; automatic retry is unsafe."
          : "Instagram Graph API request failed.",
        options.ambiguousOnNetworkFailure
          ? "INSTAGRAM_GRAPH_AMBIGUOUS_WRITE"
          : "INSTAGRAM_GRAPH_TRANSPORT",
        { operation },
        cause
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw graphError("Instagram Graph API redirect was rejected.", "INSTAGRAM_GRAPH_REDIRECT", {
        operation,
        status: response.status,
      });
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw graphError(
        "Instagram Graph API response was too large.",
        "INSTAGRAM_GRAPH_INVALID_RESPONSE",
        {
          operation,
        }
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw graphError(
        "Instagram Graph API returned a non-JSON response.",
        "INSTAGRAM_GRAPH_INVALID_RESPONSE",
        {
          operation,
          status: response.status,
        }
      );
    }
    let text: string;
    try {
      text = await readBoundedBody(response, operation);
    } catch (cause) {
      if (cause instanceof ElizaError) throw cause;
      if (signal.aborted) {
        throw graphError(
          "Instagram Graph API request was cancelled or timed out.",
          "INSTAGRAM_GRAPH_CANCELLED",
          { operation }
        );
      }
      throw graphError(
        "Instagram Graph API response body could not be read.",
        "INSTAGRAM_GRAPH_TRANSPORT",
        { operation },
        cause
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw graphError(
        "Instagram Graph API returned malformed JSON.",
        "INSTAGRAM_GRAPH_INVALID_RESPONSE",
        {
          operation,
          status: response.status,
        }
      );
    }
    boundedJsonShape(parsed);
    if (!response.ok) {
      if (
        options.ambiguousOnNetworkFailure &&
        (response.status === 408 || response.status >= 500)
      ) {
        throw graphError(
          "Instagram Graph API write outcome is unknown; automatic retry is unsafe.",
          "INSTAGRAM_GRAPH_AMBIGUOUS_WRITE",
          { operation, status: response.status }
        );
      }
      const retryable = response.status === 429 || response.status >= 500;
      throw graphError("Instagram Graph API rejected the request.", "INSTAGRAM_GRAPH_REJECTED", {
        operation,
        status: response.status,
        retryable,
      });
    }
    return asRecord(parsed, operation);
  }

  private async collect(
    path: string,
    operation: string,
    query: Record<string, string>,
    signal?: AbortSignal
  ): Promise<unknown[]> {
    const output: unknown[] = [];
    let nextPath = path;
    let nextQuery = query;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.request(nextPath, operation, { query: nextQuery, signal });
      if (!Array.isArray(response.data)) {
        throw graphError(
          "Instagram Graph API returned invalid paged data.",
          "INSTAGRAM_GRAPH_INVALID_RESPONSE",
          {
            operation,
          }
        );
      }
      output.push(...response.data);
      const paging = response.paging;
      const next = paging && typeof paging === "object" ? (paging as JsonRecord).next : undefined;
      if (typeof next !== "string" || !next) return output;
      const target = this.pagingTarget(next, operation);
      nextPath = target.path;
      nextQuery = target.query;
    }
    throw graphError(
      "Instagram Graph API pagination exceeded its page limit.",
      "INSTAGRAM_GRAPH_INVALID_RESPONSE",
      {
        operation,
      }
    );
  }

  private pagingTarget(
    next: string,
    operation: string
  ): { path: string; query: Record<string, string> } {
    let parsed: URL;
    try {
      parsed = new URL(next);
    } catch {
      throw graphError(
        "Instagram Graph API returned an invalid paging cursor.",
        "INSTAGRAM_GRAPH_INVALID_RESPONSE",
        { operation }
      );
    }
    if (parsed.origin !== this.origin.origin || !parsed.pathname.startsWith(`/${this.version}/`)) {
      throw graphError(
        "Instagram Graph API paging origin was rejected.",
        "INSTAGRAM_GRAPH_REDIRECT",
        {
          operation,
        }
      );
    }
    const query: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams) {
      if (key !== "access_token") query[key] = value;
    }
    return { path: parsed.pathname.slice(this.version.length + 2), query };
  }

  async getOwnUser(signal?: AbortSignal): Promise<InstagramUser> {
    const response = await this.request(this.accountId, "get-own-user", {
      query: {
        fields: "id,user_id,username,name,profile_picture_url,followers_count,follows_count",
      },
      signal,
    });
    return toUser(response, "get-own-user");
  }

  async getUser(userId: string | number, signal?: AbortSignal): Promise<InstagramUser> {
    const id = normalizeId(userId, "user id");
    const response = await this.request(id, "get-user", {
      query: {
        fields:
          "id,name,username,profile_pic,follower_count,is_verified_user,is_user_follow_business,is_business_follow_user",
      },
      signal,
    });
    return toUser(response, "get-user");
  }

  async getUserByUsername(username: string, signal?: AbortSignal): Promise<InstagramUser> {
    void username;
    void signal;
    throw graphError(
      "Instagram Login cannot resolve a username without an Instagram-scoped ID from an interaction.",
      "INSTAGRAM_CAPABILITY_UNSUPPORTED",
      { operation: "username-discovery" }
    );
  }

  async getThreads(signal?: AbortSignal): Promise<InstagramThread[]> {
    const rows = await this.collect(
      `${this.accountId}/conversations`,
      "list-conversations",
      {
        platform: "instagram",
        fields: "id,updated_time",
        limit: "100",
      },
      signal
    );
    const threads: InstagramThread[] = [];
    for (let offset = 0; offset < rows.length; offset += 5) {
      const batch = rows.slice(offset, offset + 5);
      threads.push(
        ...(await Promise.all(
          batch.map(async (row) => {
            const record = asRecord(row, "list-conversations");
            const id = requiredString(record, "id", "list-conversations");
            const messages = await this.getThreadMessages(id, signal);
            const usersById = new Map<string, InstagramUser>();
            for (const message of messages) {
              if (message.user.pk !== this.accountId) usersById.set(message.user.pk, message.user);
              for (const recipient of message.recipients ?? []) {
                if (recipient.pk !== this.accountId) usersById.set(recipient.pk, recipient);
              }
            }
            const users = [...usersById.values()];
            return {
              id,
              users,
              lastActivityAt:
                record.updated_time === undefined
                  ? undefined
                  : parseGraphDate(record.updated_time, "list-conversations"),
              isGroup: users.length > 1,
              threadTitle:
                users.map((user) => user.fullName ?? user.username).join(", ") || undefined,
            };
          })
        ))
      );
    }
    return threads;
  }

  async getThreadMessages(threadId: string, signal?: AbortSignal): Promise<InstagramMessage[]> {
    const id = normalizeId(threadId, "thread id");
    let response = await this.request(id, "get-conversation", {
      query: { fields: "messages.limit(100){id,created_time,from,to,message,attachments}" },
      signal,
    });
    const envelope = asRecord(response.messages, "get-conversation");
    const messages = envelope.data;
    if (!Array.isArray(messages)) {
      throw graphError(
        "Instagram Graph API returned invalid messages.",
        "INSTAGRAM_GRAPH_INVALID_RESPONSE",
        {
          operation: "get-conversation",
        }
      );
    }
    const rows = [...messages];
    let paging = envelope.paging;
    for (let page = 1; page < MAX_PAGES; page += 1) {
      const next = paging && typeof paging === "object" ? (paging as JsonRecord).next : undefined;
      if (typeof next !== "string" || !next) {
        return rows.map((message) => this.toMessage(message, id));
      }
      const target = this.pagingTarget(next, "get-conversation");
      response = await this.request(target.path, "get-conversation", {
        query: target.query,
        signal,
      });
      if (!Array.isArray(response.data)) {
        throw graphError(
          "Instagram Graph API returned invalid paged messages.",
          "INSTAGRAM_GRAPH_INVALID_RESPONSE",
          { operation: "get-conversation" }
        );
      }
      rows.push(...response.data);
      paging = response.paging;
    }
    throw graphError(
      "Instagram Graph API message pagination exceeded its page limit.",
      "INSTAGRAM_GRAPH_INVALID_RESPONSE",
      { operation: "get-conversation" }
    );
  }

  private toMessage(value: unknown, threadId: string): InstagramMessage {
    const record = asRecord(value, "get-conversation");
    const from = toUser(record.from, "get-conversation");
    return {
      id: requiredString(record, "id", "get-conversation"),
      threadId,
      text: optionalString(record, "message"),
      timestamp: parseGraphDate(record.created_time, "get-conversation"),
      user: from,
      recipients: this.toRecipients(record.to),
    };
  }

  private toRecipients(value: unknown): InstagramUser[] {
    if (value === undefined) return [];
    const data = Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as JsonRecord).data)
        ? ((value as JsonRecord).data as unknown[])
        : null;
    if (!data) {
      throw graphError(
        "Instagram Graph API returned invalid message recipients.",
        "INSTAGRAM_GRAPH_INVALID_RESPONSE",
        { operation: "get-conversation" }
      );
    }
    return data.map((recipient) => toUser(recipient, "get-conversation"));
  }

  async sendDirectMessage(threadId: string, text: string, signal?: AbortSignal): Promise<string> {
    const id = normalizeId(threadId, "thread id");
    const threads = await this.getThreads(signal);
    const thread = threads.find((candidate) => candidate.id === id);
    const recipient = thread?.users[0];
    if (thread?.users.length !== 1 || !recipient) {
      throw graphError(
        "Instagram direct-message target is unavailable or is not a supported one-to-one conversation.",
        "INSTAGRAM_TARGET_UNSUPPORTED"
      );
    }
    const response = await this.request(`${this.accountId}/messages`, "send-message", {
      method: "POST",
      body: { recipient: { id: String(recipient.pk) }, message: { text } },
      signal,
      ambiguousOnNetworkFailure: true,
    });
    return requiredString(response, "message_id", "send-message");
  }

  async postComment(mediaId: string | number, text: string, signal?: AbortSignal): Promise<string> {
    const id = normalizeId(mediaId, "media id");
    const response = await this.request(`${id}/comments`, "post-comment", {
      method: "POST",
      body: new URLSearchParams({ message: text }),
      signal,
      ambiguousOnNetworkFailure: true,
    });
    return requiredString(response, "id", "post-comment");
  }

  async replyToComment(
    commentId: string | number,
    text: string,
    signal?: AbortSignal
  ): Promise<string> {
    const id = normalizeId(commentId, "comment id");
    const response = await this.request(`${id}/replies`, "reply-comment", {
      method: "POST",
      body: new URLSearchParams({ message: text }),
      signal,
      ambiguousOnNetworkFailure: true,
    });
    return requiredString(response, "id", "reply-comment");
  }

  async getUserMedia(userId: string | number, signal?: AbortSignal): Promise<InstagramMedia[]> {
    const id = normalizeId(userId, "user id");
    if (id !== this.accountId) {
      throw graphError(
        "Instagram Login exposes media only for the configured professional account.",
        "INSTAGRAM_CAPABILITY_UNSUPPORTED",
        { operation: "third-party-media" }
      );
    }
    const rows = await this.collect(
      `${id}/media`,
      "list-media",
      {
        fields:
          "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count",
        limit: "100",
      },
      signal
    );
    return rows.map((row) => toMedia(row, "list-media"));
  }
}
