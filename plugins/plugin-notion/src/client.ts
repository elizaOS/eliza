/**
 * Fetch-based Notion REST client (API version 2022-06-28) behind the service.
 * Speaks the real wire protocol — search with cursor pagination, page reads,
 * paginated block-children reads flattened to plain text, page creation, and
 * paragraph appends — and translates every upstream failure into a typed
 * `ElizaError` (`NOTION_AUTH_EXPIRED`, `NOTION_RATE_LIMITED`,
 * `NOTION_MALFORMED_RESPONSE`, `NOTION_UPSTREAM_FAILURE`, …) so callers branch
 * on codes, never on HTTP details. The base URL is overridable via
 * `ELIZA_MOCK_NOTION_BASE` for protocol-faithful mock servers in tests.
 */
import { ElizaError } from "@elizaos/core";
import type {
  NotionAccountRef,
  NotionAppendInput,
  NotionCreatePageInput,
  NotionCredentialResolver,
  NotionObjectSummary,
  NotionPageContent,
  NotionSearchPage,
} from "./types.js";

export const NOTION_API_VERSION = "2022-06-28";
export const NOTION_DEFAULT_BASE_URL = "https://api.notion.com";
/** Maximum time allowed for one Notion API request. */
export const NOTION_FETCH_TIMEOUT_MS = 20_000;

const MAX_PAGE_SIZE = 100;
/** Cap block-children pagination so one pathological page cannot spin forever. */
const MAX_CONTENT_PAGES = 20;

type JsonRecord = Record<string, unknown>;

export interface NotionClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class NotionClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentialResolver: NotionCredentialResolver,
    options: NotionClientOptions = {}
  ) {
    this.baseUrl = (
      options.baseUrl ??
      process.env.ELIZA_MOCK_NOTION_BASE ??
      NOTION_DEFAULT_BASE_URL
    ).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? NOTION_FETCH_TIMEOUT_MS;
  }

  async search(
    params: NotionAccountRef & { query: string; cursor?: string; limit?: number }
  ): Promise<NotionSearchPage> {
    const body: JsonRecord = {
      query: params.query,
      page_size: normalizedPageSize(params.limit),
      sort: { direction: "descending", timestamp: "last_edited_time" },
    };
    if (params.cursor) {
      body.start_cursor = params.cursor;
    }
    const payload = await this.request(params, "POST", "/v1/search", body);
    const results = readArray(payload, "results").map(mapObjectSummary);
    return {
      results,
      nextCursor: readNullableString(payload, "next_cursor"),
      hasMore: payload.has_more === true,
    };
  }

  async getPage(params: NotionAccountRef & { pageId: string }): Promise<NotionObjectSummary> {
    const payload = await this.request(
      params,
      "GET",
      `/v1/pages/${encodeURIComponent(params.pageId)}`
    );
    return mapObjectSummary(payload);
  }

  async getPageContent(params: NotionAccountRef & { pageId: string }): Promise<NotionPageContent> {
    const page = await this.getPage(params);
    const lines: string[] = [];
    const unsupported = new Set<string>();
    let cursor: string | null = null;
    for (let fetched = 0; fetched < MAX_CONTENT_PAGES; fetched += 1) {
      const query = cursor
        ? `?page_size=${MAX_PAGE_SIZE}&start_cursor=${encodeURIComponent(cursor)}`
        : `?page_size=${MAX_PAGE_SIZE}`;
      const payload = await this.request(
        params,
        "GET",
        `/v1/blocks/${encodeURIComponent(params.pageId)}/children${query}`
      );
      for (const block of readArray(payload, "results")) {
        const text = blockPlainText(block);
        if (text !== null) {
          if (text.length > 0) lines.push(text);
        } else {
          unsupported.add(typeof block.type === "string" ? block.type : "unknown");
        }
      }
      cursor = payload.has_more === true ? readNullableString(payload, "next_cursor") : null;
      if (!cursor) break;
    }
    return {
      id: page.id,
      title: page.title,
      url: page.url,
      plainText: lines.join("\n"),
      unsupportedBlockTypes: [...unsupported].sort(),
    };
  }

  async createPage(params: NotionCreatePageInput): Promise<NotionObjectSummary> {
    const body: JsonRecord = {
      parent: { page_id: params.parentPageId },
      properties: {
        title: { title: [{ type: "text", text: { content: params.title } }] },
      },
    };
    if (params.content) {
      body.children = paragraphBlocks(params.content);
    }
    const payload = await this.request(params, "POST", "/v1/pages", body);
    return mapObjectSummary(payload);
  }

  async appendToPage(params: NotionAppendInput): Promise<void> {
    await this.request(
      params,
      "PATCH",
      `/v1/blocks/${encodeURIComponent(params.pageId)}/children`,
      { children: paragraphBlocks(params.content) }
    );
  }

  private async request(
    account: NotionAccountRef,
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: JsonRecord
  ): Promise<JsonRecord> {
    const credential = await this.credentialResolver.getCredential(account);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "Notion-Version": NOTION_API_VERSION,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw await notionHttpError(response, { accountId: account.accountId, path });
    }

    const parsed: unknown = await response.json().catch((cause: unknown) => {
      throw new ElizaError("NotionClient: Notion returned a non-JSON success body.", {
        code: "NOTION_MALFORMED_RESPONSE",
        context: { path, accountId: account.accountId },
        cause: cause instanceof Error ? cause : undefined,
      });
    });
    if (!isRecord(parsed)) {
      throw new ElizaError("NotionClient: Notion returned a non-object success body.", {
        code: "NOTION_MALFORMED_RESPONSE",
        context: { path, accountId: account.accountId, bodyType: typeof parsed },
      });
    }
    return parsed;
  }
}

async function notionHttpError(
  response: Response,
  context: { accountId: string; path: string }
): Promise<ElizaError> {
  // error-policy:J3 the upstream error body is untrusted; an unparseable body
  // degrades to an empty record and the HTTP status still drives the code.
  const body: JsonRecord = await response
    .json()
    .then((value: unknown) => (isRecord(value) ? value : {}))
    .catch(() => ({}));
  const upstreamCode = typeof body.code === "string" ? body.code : undefined;
  const upstreamMessage = typeof body.message === "string" ? body.message : undefined;
  const base = { ...context, status: response.status, upstreamCode, upstreamMessage };

  if (response.status === 401) {
    return new ElizaError(
      "NotionClient: access token is invalid, expired, or revoked; reconnect the Notion account.",
      { code: "NOTION_AUTH_EXPIRED", context: base }
    );
  }
  if (response.status === 403) {
    return new ElizaError(
      "NotionClient: the integration does not have access to this resource; share it with the connection in Notion.",
      { code: "NOTION_FORBIDDEN", context: base }
    );
  }
  if (response.status === 404) {
    return new ElizaError("NotionClient: resource not found or not shared with the connection.", {
      code: "NOTION_NOT_FOUND",
      context: base,
    });
  }
  if (response.status === 429) {
    return new ElizaError("NotionClient: rate limited by Notion; retry after the given delay.", {
      code: "NOTION_RATE_LIMITED",
      context: { ...base, retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")) },
    });
  }
  if (response.status === 400 && upstreamCode === "validation_error") {
    return new ElizaError(`NotionClient: request rejected: ${upstreamMessage ?? "invalid input"}`, {
      code: "NOTION_INVALID_REQUEST",
      context: base,
    });
  }
  return new ElizaError(`NotionClient: Notion request failed with status ${response.status}.`, {
    code: "NOTION_UPSTREAM_FAILURE",
    context: base,
  });
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizedPageSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 25;
  }
  return Math.min(Math.trunc(value), MAX_PAGE_SIZE);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readArray(payload: JsonRecord, key: string): JsonRecord[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new ElizaError(`NotionClient: Notion response is missing the "${key}" array.`, {
      code: "NOTION_MALFORMED_RESPONSE",
      context: { key, valueType: typeof value },
    });
  }
  return value.filter(isRecord);
}

function readNullableString(payload: JsonRecord, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapObjectSummary(item: JsonRecord): NotionObjectSummary {
  const object = item.object === "database" ? "database" : "page";
  const id = typeof item.id === "string" ? item.id : "";
  const url = typeof item.url === "string" ? item.url : "";
  if (!id || !url) {
    throw new ElizaError("NotionClient: Notion object is missing its id or url.", {
      code: "NOTION_MALFORMED_RESPONSE",
      context: { object, hasId: Boolean(id), hasUrl: Boolean(url) },
    });
  }
  return {
    id,
    object,
    title: extractTitle(item),
    url,
    lastEditedTime: typeof item.last_edited_time === "string" ? item.last_edited_time : "",
    createdTime: typeof item.created_time === "string" ? item.created_time : "",
    archived: item.archived === true,
    parentType: parentType(item.parent),
  };
}

function parentType(parent: unknown): NotionObjectSummary["parentType"] {
  if (!isRecord(parent) || typeof parent.type !== "string") return "unknown";
  switch (parent.type) {
    case "workspace":
    case "page_id":
    case "database_id":
    case "block_id":
      return parent.type;
    default:
      return "unknown";
  }
}

function extractTitle(item: JsonRecord): string {
  // Databases carry `title` at the top level; pages nest it inside the
  // property whose value type is "title" (property name varies per database).
  if (Array.isArray(item.title)) {
    return richTextPlain(item.title);
  }
  if (isRecord(item.properties)) {
    for (const property of Object.values(item.properties)) {
      if (isRecord(property) && property.type === "title" && Array.isArray(property.title)) {
        return richTextPlain(property.title);
      }
    }
  }
  return "";
}

function richTextPlain(spans: unknown[]): string {
  return spans
    .filter(isRecord)
    .map((span) => (typeof span.plain_text === "string" ? span.plain_text : ""))
    .join("");
}

const TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "quote",
  "callout",
  "toggle",
  "code",
]);

/** Returns the block's plain text, or null when the block type is unsupported. */
function blockPlainText(block: JsonRecord): string | null {
  const type = typeof block.type === "string" ? block.type : "";
  if (!TEXT_BLOCK_TYPES.has(type)) {
    return type === "divider" ? "" : null;
  }
  const payload = block[type];
  if (!isRecord(payload) || !Array.isArray(payload.rich_text)) {
    return "";
  }
  const text = richTextPlain(payload.rich_text);
  if (type === "to_do") {
    return `${payload.checked === true ? "[x]" : "[ ]"} ${text}`;
  }
  return text;
}

function paragraphBlocks(content: string): JsonRecord[] {
  return content.split("\n").map((line) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: line.length > 0 ? [{ type: "text", text: { content: line } }] : [],
    },
  }));
}
