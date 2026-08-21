/**
 * Fetch-based Dropbox API v2 client behind the service. RPC endpoints
 * (list_folder, list_folder/continue, search_v2, search/continue_v2,
 * get_metadata, get_temporary_link) go to the api host; content endpoints
 * (download, upload) go to the content host with `Dropbox-API-Arg` headers.
 * Every upstream failure is translated into a typed `ElizaError`
 * (`DROPBOX_AUTH_EXPIRED`, `DROPBOX_RATE_LIMITED`, `DROPBOX_NOT_FOUND`,
 * `DROPBOX_MALFORMED_RESPONSE`, `DROPBOX_UPSTREAM_FAILURE`, …) so callers
 * branch on codes, never on HTTP details. Base URLs are overridable via
 * `ELIZA_MOCK_DROPBOX_BASE` / `ELIZA_MOCK_DROPBOX_CONTENT_BASE` for
 * protocol-faithful mock servers in tests.
 *
 * File limitation UX: `downloadText` refuses binary-looking or oversized files
 * with `DROPBOX_FILE_NOT_TEXT` / `DROPBOX_FILE_TOO_LARGE` instead of returning
 * garbage, so callers can point the user at the temporary link instead.
 */
import { ElizaError, toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { readBoundedResponse } from "./bounded-response.js";
import type {
  DropboxAccountRef,
  DropboxCredentialResolver,
  DropboxEntry,
  DropboxFileText,
  DropboxListPage,
  DropboxUploadInput,
} from "./types.js";

export const DROPBOX_DEFAULT_API_BASE = "https://api.dropboxapi.com";
export const DROPBOX_DEFAULT_CONTENT_BASE = "https://content.dropboxapi.com";
/** Maximum time allowed for one Dropbox API request. */
export const DROPBOX_FETCH_TIMEOUT_MS = 30_000;
/** Refuse to decode files larger than this as text (protects model context). */
export const DROPBOX_MAX_TEXT_BYTES = 1_000_000;
/** Dropbox's single-request upload endpoint accepts at most 150 MB. */
export const DROPBOX_MAX_UPLOAD_BYTES = 150_000_000;

const DROPBOX_MAX_JSON_BYTES = 4_000_000;
const DROPBOX_MAX_ERROR_BYTES = 64_000;

const MAX_PAGE_SIZE = 1000;

type JsonRecord = Record<string, unknown>;

export interface DropboxClientOptions {
  apiBaseUrl?: string;
  contentBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class DropboxClient {
  private readonly apiBase: string;
  private readonly contentBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentialResolver: DropboxCredentialResolver,
    options: DropboxClientOptions = {}
  ) {
    this.apiBase = (
      options.apiBaseUrl ??
      process.env.ELIZA_MOCK_DROPBOX_BASE ??
      DROPBOX_DEFAULT_API_BASE
    ).replace(/\/$/, "");
    this.contentBase = (
      options.contentBaseUrl ??
      process.env.ELIZA_MOCK_DROPBOX_CONTENT_BASE ??
      process.env.ELIZA_MOCK_DROPBOX_BASE ??
      DROPBOX_DEFAULT_CONTENT_BASE
    ).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DROPBOX_FETCH_TIMEOUT_MS;
  }

  async listFolder(
    params: DropboxAccountRef & { path?: string; cursor?: string; limit?: number }
  ): Promise<DropboxListPage> {
    const payload = params.cursor
      ? await this.rpc(params, "/2/files/list_folder/continue", { cursor: params.cursor })
      : await this.rpc(params, "/2/files/list_folder", {
          path: params.path ?? "",
          limit: normalizedPageSize(params.limit),
          recursive: false,
          include_deleted: false,
        });
    return {
      entries: readArray(payload, "entries").map(mapEntry),
      cursor: readNullableString(payload, "cursor"),
      hasMore: payload.has_more === true,
    };
  }

  async search(
    params: DropboxAccountRef & { query: string; cursor?: string; limit?: number }
  ): Promise<DropboxListPage> {
    const payload = params.cursor
      ? await this.rpc(params, "/2/files/search/continue_v2", { cursor: params.cursor })
      : await this.rpc(params, "/2/files/search_v2", {
          query: params.query,
          options: { max_results: Math.min(normalizedPageSize(params.limit), 100) },
        });
    const matches = readArray(payload, "matches");
    const entries: DropboxEntry[] = [];
    for (const match of matches) {
      const metadata = asRecord(asRecord(match.metadata)?.metadata);
      if (metadata) {
        entries.push(mapEntry(metadata));
      }
    }
    return {
      entries,
      cursor: readNullableString(payload, "cursor"),
      hasMore: payload.has_more === true,
    };
  }

  async getMetadata(params: DropboxAccountRef & { path: string }): Promise<DropboxEntry> {
    const payload = await this.rpc(params, "/2/files/get_metadata", {
      path: params.path,
      include_deleted: false,
    });
    return mapEntry(payload);
  }

  async downloadText(params: DropboxAccountRef & { path: string }): Promise<DropboxFileText> {
    const entry = await this.getMetadata(params);
    if (entry.kind !== "file") {
      throw new ElizaError(`DropboxClient: ${params.path} is a ${entry.kind}, not a file.`, {
        code: "DROPBOX_NOT_A_FILE",
        context: { path: params.path, kind: entry.kind },
      });
    }
    if (typeof entry.size === "number" && entry.size > DROPBOX_MAX_TEXT_BYTES) {
      throw new ElizaError(
        `DropboxClient: ${params.path} is ${entry.size} bytes, larger than the ${DROPBOX_MAX_TEXT_BYTES}-byte text read cap. Use getTemporaryLink instead.`,
        {
          code: "DROPBOX_FILE_TOO_LARGE",
          context: { path: params.path, size: entry.size, cap: DROPBOX_MAX_TEXT_BYTES },
        }
      );
    }

    const credential = await this.credentialResolver.getCredential(params);
    const response = await this.fetchImpl(`${this.contentBase}/2/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "Dropbox-API-Arg": dropboxApiArg({ path: params.path }),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw await dropboxHttpError(
        response,
        { accountId: params.accountId, path: "/2/files/download" },
        this.timeoutMs
      );
    }
    const bytes = await readDropboxBody(
      response,
      DROPBOX_MAX_TEXT_BYTES,
      params.path,
      this.timeoutMs,
      { tooLargeCode: "DROPBOX_FILE_TOO_LARGE" }
    );
    if (looksBinary(bytes)) {
      throw new ElizaError(
        `DropboxClient: ${params.path} does not decode as text. Use getTemporaryLink instead.`,
        { code: "DROPBOX_FILE_NOT_TEXT", context: { path: params.path, bytes: bytes.length } }
      );
    }
    try {
      return { entry, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch (cause) {
      // error-policy:J3 invalid UTF-8 is an explicit non-text result, never replacement text.
      throw new ElizaError(
        `DropboxClient: ${params.path} is not valid UTF-8 text. Use getTemporaryLink instead.`,
        {
          code: "DROPBOX_FILE_NOT_TEXT",
          context: { path: params.path, bytes: bytes.length },
          cause: cause instanceof Error ? cause : undefined,
        }
      );
    }
  }

  async upload(params: DropboxUploadInput): Promise<DropboxEntry> {
    const credential = await this.credentialResolver.getCredential(params);
    const bytes =
      typeof params.content === "string"
        ? new TextEncoder().encode(params.content)
        : params.content;
    if (bytes.byteLength > DROPBOX_MAX_UPLOAD_BYTES) {
      throw new ElizaError(
        `DropboxClient: upload is ${bytes.byteLength} bytes, larger than the ${DROPBOX_MAX_UPLOAD_BYTES}-byte single-request cap.`,
        {
          code: "DROPBOX_FILE_TOO_LARGE",
          context: { path: params.path, bytes: bytes.byteLength, cap: DROPBOX_MAX_UPLOAD_BYTES },
        }
      );
    }
    // Copy into a plain ArrayBuffer-backed Blob so BodyInit accepts it
    // regardless of the source view's underlying buffer type.
    const body = new Blob([bytes.slice()]);
    const response = await this.fetchImpl(`${this.contentBase}/2/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": dropboxApiArg({
          path: params.path,
          mode: params.mode ?? "add",
          autorename: false,
          mute: true,
        }),
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw await dropboxHttpError(
        response,
        { accountId: params.accountId, path: "/2/files/upload" },
        this.timeoutMs
      );
    }
    const payload = await parseJsonRecord(
      response,
      "/2/files/upload",
      params.accountId,
      this.timeoutMs
    );
    return mapEntry({ ".tag": "file", ...payload });
  }

  async getTemporaryLink(params: DropboxAccountRef & { path: string }): Promise<string> {
    const payload = await this.rpc(params, "/2/files/get_temporary_link", { path: params.path });
    const link = readNullableString(payload, "link");
    if (!link) {
      throw new ElizaError("DropboxClient: get_temporary_link response is missing the link.", {
        code: "DROPBOX_MALFORMED_RESPONSE",
        context: { path: params.path },
      });
    }
    return link;
  }

  private async rpc(
    account: DropboxAccountRef,
    path: string,
    body: JsonRecord
  ): Promise<JsonRecord> {
    const credential = await this.credentialResolver.getCredential(account);
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw await dropboxHttpError(
        response,
        { accountId: account.accountId, path },
        this.timeoutMs
      );
    }
    return parseJsonRecord(response, path, account.accountId, this.timeoutMs);
  }
}

async function parseJsonRecord(
  response: Response,
  path: string,
  accountId: string,
  timeoutMs: number
): Promise<JsonRecord> {
  const bytes = await readDropboxBody(response, DROPBOX_MAX_JSON_BYTES, path, timeoutMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    // error-policy:J3 the success body is untrusted and must be valid bounded UTF-8 JSON.
    throw new ElizaError("DropboxClient: Dropbox returned a non-JSON success body.", {
      code: "DROPBOX_MALFORMED_RESPONSE",
      context: { path, accountId },
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (!isRecord(parsed)) {
    throw new ElizaError("DropboxClient: Dropbox returned a non-object success body.", {
      code: "DROPBOX_MALFORMED_RESPONSE",
      context: { path, accountId, bodyType: typeof parsed },
    });
  }
  return parsed;
}

async function dropboxHttpError(
  response: Response,
  context: { accountId: string; path: string },
  timeoutMs: number
): Promise<ElizaError> {
  // error-policy:J3 the upstream error body is untrusted; an unparseable body
  // degrades to an empty record and the HTTP status still drives the code.
  let bodyBytes: Uint8Array = new Uint8Array();
  try {
    bodyBytes = await readDropboxBody(response, DROPBOX_MAX_ERROR_BYTES, context.path, timeoutMs);
  } catch {
    // error-policy:J3 malformed, stalled, or oversized error bodies are ignored; status is authoritative.
  }
  let bodyText = "";
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    // error-policy:J3 malformed error text is ignored; HTTP status remains authoritative.
  }
  let body: JsonRecord = {};
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed)) body = parsed;
  } catch {
    // 409/429 bodies are JSON; auth failures can be plain text.
  }
  const errorTag = errorTagOf(body);
  const summary = typeof body.error_summary === "string" ? body.error_summary : undefined;
  const base = { ...context, status: response.status, errorTag, summary };

  if (response.status === 401) {
    return new ElizaError(
      "DropboxClient: access token is invalid, expired, or revoked; refresh or reconnect the Dropbox account.",
      { code: "DROPBOX_AUTH_EXPIRED", context: base }
    );
  }
  if (response.status === 403) {
    return new ElizaError("DropboxClient: access denied for this resource.", {
      code: "DROPBOX_FORBIDDEN",
      context: base,
    });
  }
  if (response.status === 429) {
    const retryAfterBody = asRecord(body.error)?.retry_after;
    return new ElizaError("DropboxClient: rate limited by Dropbox; retry after the given delay.", {
      code: "DROPBOX_RATE_LIMITED",
      context: {
        ...base,
        retryAfterSeconds:
          typeof retryAfterBody === "number"
            ? retryAfterBody
            : parseRetryAfter(response.headers.get("Retry-After")),
      },
    });
  }
  if (response.status === 409) {
    if (summary?.includes("not_found") || errorTag === "path" || errorTag === "path_lookup") {
      const pathTag = pathErrorTag(body);
      if (pathTag === "not_found" || summary?.includes("not_found")) {
        return new ElizaError("DropboxClient: path not found.", {
          code: "DROPBOX_NOT_FOUND",
          context: base,
        });
      }
    }
    return new ElizaError(
      `DropboxClient: request conflicted: ${summary ?? errorTag ?? "unknown endpoint error"}`,
      { code: "DROPBOX_INVALID_REQUEST", context: base }
    );
  }
  if (response.status === 400) {
    // Preserve existing contract: parsed error_summary is unbounded diagnostic
    // text (sanitized only), while the raw-body fallback remains capped at 200.
    // Both paths are sanitized to well-formed Unicode so a .slice() at the
    // boundary never leaves a lone surrogate in the ElizaError message.
    const safeDetail =
      summary !== undefined
        ? toWellFormedUnicode(summary)
        : truncateWellFormed(toWellFormedUnicode(bodyText || "bad input"), 200);
    return new ElizaError(`DropboxClient: request rejected: ${safeDetail}`, {
      code: "DROPBOX_INVALID_REQUEST",
      context: base,
    });
  }
  return new ElizaError(`DropboxClient: Dropbox request failed with status ${response.status}.`, {
    code: "DROPBOX_UPSTREAM_FAILURE",
    context: base,
  });
}

async function readDropboxBody(
  response: Response,
  maxBytes: number,
  path: string,
  timeoutMs: number,
  options: { tooLargeCode?: string } = {}
): Promise<Uint8Array> {
  return readBoundedResponse(response, maxBytes, timeoutMs, {
    tooLarge: (declaredBytes) =>
      new ElizaError("DropboxClient: Dropbox response exceeded the permitted body size.", {
        code: options.tooLargeCode ?? "DROPBOX_MALFORMED_RESPONSE",
        context: { path, cap: maxBytes, declaredBytes },
      }),
    timedOut: () =>
      new ElizaError("DropboxClient: timed out while reading the Dropbox response body.", {
        code: "DROPBOX_UPSTREAM_FAILURE",
        context: { path, timeoutMs },
      }),
    readFailed: (cause) =>
      new ElizaError("DropboxClient: failed while reading the Dropbox response body.", {
        code: "DROPBOX_UPSTREAM_FAILURE",
        context: { path },
        cause: cause instanceof Error ? cause : undefined,
      }),
  });
}

function errorTagOf(body: JsonRecord): string | undefined {
  const error = asRecord(body.error);
  const tag = error?.[".tag"];
  return typeof tag === "string" ? tag : undefined;
}

function pathErrorTag(body: JsonRecord): string | undefined {
  const error = asRecord(body.error);
  const path = asRecord(error?.path) ?? asRecord(error?.path_lookup);
  const tag = path?.[".tag"];
  return typeof tag === "string" ? tag : undefined;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizedPageSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 100;
  }
  return Math.min(Math.trunc(value), MAX_PAGE_SIZE);
}

/** Dropbox-API-Arg must be ASCII-safe; non-ASCII is escaped per Dropbox docs. */
export function dropboxApiArg(value: JsonRecord): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function readArray(payload: JsonRecord, key: string): JsonRecord[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new ElizaError(`DropboxClient: Dropbox response is missing the "${key}" array.`, {
      code: "DROPBOX_MALFORMED_RESPONSE",
      context: { key, valueType: typeof value },
    });
  }
  return value.filter(isRecord);
}

function readNullableString(payload: JsonRecord, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapEntry(item: JsonRecord): DropboxEntry {
  const tag = item[".tag"];
  const kind = tag === "folder" ? "folder" : tag === "deleted" ? "deleted" : "file";
  const name = typeof item.name === "string" ? item.name : "";
  const pathLower = typeof item.path_lower === "string" ? item.path_lower : "";
  const pathDisplay = typeof item.path_display === "string" ? item.path_display : pathLower;
  if (!name || (!pathLower && kind !== "deleted")) {
    throw new ElizaError("DropboxClient: Dropbox entry is missing its name or path.", {
      code: "DROPBOX_MALFORMED_RESPONSE",
      context: { kind, hasName: Boolean(name), hasPath: Boolean(pathLower) },
    });
  }
  return {
    kind,
    id: typeof item.id === "string" ? item.id : "",
    name,
    pathLower,
    pathDisplay,
    url: dropboxDeepLink(pathDisplay, kind),
    size: typeof item.size === "number" ? item.size : undefined,
    clientModified: typeof item.client_modified === "string" ? item.client_modified : undefined,
    serverModified: typeof item.server_modified === "string" ? item.server_modified : undefined,
    contentHash: typeof item.content_hash === "string" ? item.content_hash : undefined,
  };
}

/** Deterministic dropbox.com deep link: folders browse in /home, files preview. */
export function dropboxDeepLink(pathDisplay: string, kind: DropboxEntry["kind"]): string {
  if (!pathDisplay) return "https://www.dropbox.com/home";
  const encoded = pathDisplay
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (kind === "folder") {
    return `https://www.dropbox.com/home${encoded}`;
  }
  const lastSlash = pathDisplay.lastIndexOf("/");
  const parent = pathDisplay.slice(0, Math.max(lastSlash, 0));
  const file = pathDisplay.slice(lastSlash + 1);
  const encodedParent = parent
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://www.dropbox.com/home${encodedParent}?preview=${encodeURIComponent(file)}`;
}
