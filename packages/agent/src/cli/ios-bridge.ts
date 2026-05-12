import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";

import {
  ChannelType,
  createMessageMemory,
  type GenerateTextParams,
  type IAgentRuntime,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

import { dispatchRoute } from "../api/dispatch-route.ts";
import { installMobileFsShim } from "./mobile-fs-shim.ts";

interface BridgeRequest {
  id?: unknown;
  method?: unknown;
  payload?: unknown;
}

interface BridgeResponse {
  id: unknown;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface HostCallFrame {
  type: "host_call";
  id: string;
  method: string;
  payload?: unknown;
  timeoutMs?: number;
}

interface HostResultFrame {
  type: "host_result";
  id?: unknown;
  envelope?: unknown;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

interface BridgeReadyFrame {
  type: "ready";
  ok: boolean;
  result?: {
    ready: true;
    apiPort: number;
  };
  error?: string;
}

type BridgeFrame = BridgeReadyFrame | BridgeResponse;
type BridgeOutboundFrame = BridgeFrame | HostCallFrame;

interface HttpRequestPayload {
  method?: unknown;
  path?: unknown;
  headers?: unknown;
  body?: unknown;
  bodyBase64?: unknown;
  bodyEncoding?: unknown;
  timeoutMs?: unknown;
}

interface IosBridgeBackend {
  /**
   * The runtime is the canonical entry point for IPC routing. `dispatchRoute`
   * runs the matched route handler directly, with no loopback HTTP hop.
   */
  runtime: IAgentRuntime;
  conversations: Map<string, IosConversation>;
  fallbackPort: number;
  close: () => Promise<void>;
}

interface IosBridgeHost {
  backendPromise: Promise<IosBridgeBackend>;
  backend: IosBridgeBackend | null;
  bootError: unknown;
}

interface IosConversation {
  id: string;
  title: string;
  roomId: UUID;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

interface BufferedHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyBase64: string;
  bodyEncoding: "utf-8";
}

interface InstalledModelEntry {
  id: string;
  displayName?: string;
  path: string;
  sizeBytes?: number;
  installedAt?: string;
  lastUsedAt?: string | null;
  source?: string;
  bundleVerifiedAt?: string;
  dimensions?: number;
  embeddingDimension?: number;
  embeddingDimensions?: number;
}

interface NativeLlamaState {
  contextId: number | null;
  modelId: string | null;
  modelPath: string | null;
  loadedAt: string | null;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
}

interface RuntimeMessageService {
  handleMessage: (
    runtime: IAgentRuntime,
    message: ReturnType<typeof createMessageMemory>,
    onResponse: (
      content: { text?: string } | null | undefined,
    ) => Promise<unknown[]> | unknown[],
  ) => Promise<unknown> | unknown;
}

type GenerateTextHandler = (
  runtime: IAgentRuntime,
  params: GenerateTextParams,
) => Promise<string>;

type RuntimeWithModelRegistration = IAgentRuntime & {
  registerModel?: (
    modelType: string | number,
    handler: GenerateTextHandler,
    provider: string,
    priority?: number,
  ) => void;
};

const IOS_NATIVE_LLAMA_PROVIDER = "capacitor-llama";
const IOS_NATIVE_LLAMA_DEVICE_ID = "ios-native-llama";
const IOS_NATIVE_LLAMA_PRIORITY = 0;
const TEXT_GENERATION_MODEL_TYPES = [
  ModelType.TEXT_NANO,
  ModelType.TEXT_SMALL,
  ModelType.TEXT_MEDIUM,
  ModelType.TEXT_LARGE,
  ModelType.RESPONSE_HANDLER,
  ModelType.ACTION_PLANNER,
  ModelType.TEXT_COMPLETION,
] as const;
const nativeLlamaState: NativeLlamaState = {
  contextId: null,
  modelId: null,
  modelPath: null,
  loadedAt: null,
  status: "idle",
};
const pendingHostCalls = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();
let hostProtocolWrite: ((frame: BridgeOutboundFrame) => void) | null = null;
let nextHostCallId = 1;

function normalizeHeaderRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") {
      out[key] = String(raw);
    }
  }
  return out;
}

function isSafeLocalPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(path)
  );
}

function normalizeMethod(value: unknown): string {
  const method = (typeof value === "string" ? value : "GET")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) {
    throw new Error("Unsupported HTTP method");
  }
  return method;
}

async function startIosBridgeBackend(): Promise<IosBridgeBackend> {
  // ── Mobile filesystem sandbox ────────────────────────────────────────────
  // Install the fs shim as the very first action — before any runtime code
  // runs — so that PGlite, trajectory logs, skill files, and all other agent
  // I/O is confined to the app's writable workspace directory.
  //
  // MOBILE_WORKSPACE_ROOT is set by the native Swift host (ElizaBunEngine)
  // to `SandboxPaths.appSupport + "/workspace"`.  On Android it is set by
  // the nodejs-mobile bridge to `context.getFilesDir()/eliza/workspace`.
  // Fall back to a sensible default so the agent can still boot in
  // simulator / dev builds where the native host hasn't set it yet.
  const mobileWorkspaceRoot =
    process.env.MOBILE_WORKSPACE_ROOT ||
    (process.env.HOME
      ? `${process.env.HOME}/Library/Application Support/Eliza/workspace`
      : "/tmp/eliza-workspace");
  installMobileFsShim(mobileWorkspaceRoot);

  (
    globalThis as { __ELIZA_DISABLE_DIRECT_RUN?: boolean }
  ).__ELIZA_DISABLE_DIRECT_RUN = true;
  process.env.ELIZA_PLATFORM = process.env.ELIZA_PLATFORM || "ios";
  process.env.ELIZA_MOBILE_PLATFORM =
    process.env.ELIZA_MOBILE_PLATFORM || "ios";
  process.env.ELIZA_IOS_LOCAL_BACKEND =
    process.env.ELIZA_IOS_LOCAL_BACKEND || "1";
  process.env.ELIZA_DISABLE_DIRECT_RUN =
    process.env.ELIZA_DISABLE_DIRECT_RUN || "1";
  process.env.ELIZA_HEADLESS = process.env.ELIZA_HEADLESS || "1";
  process.env.ELIZA_API_BIND = process.env.ELIZA_API_BIND || "127.0.0.1";
  process.env.ELIZA_VAULT_BACKEND = process.env.ELIZA_VAULT_BACKEND || "file";
  process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER =
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER || "1";
  process.env.ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP =
    process.env.ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP || "1";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

  const { bootElizaRuntime } = await import("../runtime/index.ts");

  const runtime = await bootElizaRuntime();
  installIosNativeLlamaHandlers(runtime);

  return {
    runtime,
    conversations: new Map(),
    fallbackPort: 0,
    close: async () => {
      await unloadNativeLlamaModel().catch(() => undefined);
    },
  };
}

function startIosBridgeHost(): IosBridgeHost {
  const host: IosBridgeHost = {
    backend: null,
    bootError: null,
    backendPromise: Promise.resolve(null as unknown as IosBridgeBackend),
  };
  host.backendPromise = startIosBridgeBackend().then(
    (backend) => {
      host.backend = backend;
      return backend;
    },
    (error) => {
      host.bootError = error;
      throw error;
    },
  );
  host.backendPromise.catch(() => {
    // Status requests report `bootError`; keep the bridge process alive so the
    // native host receives the real startup failure instead of a closed pipe.
  });
  return host;
}

async function awaitIosBridgeBackend(
  host: IosBridgeHost,
  timeoutMs: number | undefined,
  label: string,
): Promise<IosBridgeBackend> {
  if (host.backend) return host.backend;
  if (host.bootError) {
    throw host.bootError instanceof Error
      ? host.bootError
      : new Error(String(host.bootError));
  }
  const result = await timeoutAfter(
    host.backendPromise,
    timeoutMs,
    `${label} backend startup`,
  );
  if (isTimeoutMarker(result)) {
    throw new Error(`${result.label} timed out after ${result.timeoutMs}ms`);
  }
  return result;
}

function splitPathAndQuery(rawPath: string): {
  pathname: string;
  query: Record<string, string | string[]>;
} {
  const qIndex = rawPath.indexOf("?");
  if (qIndex < 0) return { pathname: rawPath, query: {} };
  const pathname = rawPath.slice(0, qIndex);
  const params = new URLSearchParams(rawPath.slice(qIndex + 1));
  const query: Record<string, string | string[]> = {};
  for (const key of params.keys()) {
    const all = params.getAll(key);
    query[key] = all.length <= 1 ? (all[0] ?? "") : all;
  }
  return { pathname, query };
}

function payloadBodyAsRaw(payload: HttpRequestPayload): unknown {
  if (typeof payload.bodyBase64 === "string") {
    return Buffer.from(payload.bodyBase64, "base64");
  }
  if (payload.bodyEncoding === "base64" && typeof payload.body === "string") {
    return Buffer.from(payload.body, "base64");
  }
  return payload.body;
}

function bodyTextForLegacyRoute(payload: HttpRequestPayload): string {
  const raw = payloadBodyAsRaw(payload);
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf8");
  try {
    return JSON.stringify(raw);
  } catch {
    return "";
  }
}

function statusTextForCode(status: number): string {
  if (status === 200) return "OK";
  if (status === 201) return "Created";
  if (status === 204) return "No Content";
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 504) return "Gateway Timeout";
  if (status === 500) return "Internal Server Error";
  return "";
}

function timeoutResponse(label: string, timeoutMs: number): {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyBase64: string;
  bodyEncoding: "utf-8";
} {
  const body = JSON.stringify({
    error: `${label} timed out after ${timeoutMs}ms`,
    code: "timeout",
    timeoutMs,
  });
  return {
    status: 504,
    statusText: statusTextForCode(504),
    headers: { "content-type": "application/json; charset=utf-8" },
    body,
    bodyBase64: Buffer.from(body, "utf8").toString("base64"),
    bodyEncoding: "utf-8",
  };
}

function timeoutAfter<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T | { __timeout: true; timeoutMs: number; label: string }> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  const jsTimeoutMs = Math.max(100, timeoutMs - 500);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ __timeout: true, timeoutMs: jsTimeoutMs, label });
    }, jsTimeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function bridgeTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && value > 0
    ? Math.min(value, 30 * 60_000)
    : undefined;
}

function isTimeoutMarker(
  value: unknown,
): value is { __timeout: true; timeoutMs: number; label: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "__timeout" in value &&
      (value as { __timeout?: unknown }).__timeout === true,
  );
}

async function fetchBackend(
  backend: IosBridgeBackend,
  payload: HttpRequestPayload,
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyBase64: string;
  bodyEncoding: "utf-8";
}> {
  const rawPath = typeof payload.path === "string" ? payload.path.trim() : "";
  if (!rawPath || !isSafeLocalPath(rawPath)) {
    throw new Error(
      "iOS bridge http_request requires a path that starts with / and is not an absolute URL",
    );
  }

  const method = normalizeMethod(payload.method);
  const headers = normalizeHeaderRecord(payload.headers);
  const timeoutMs = bridgeTimeoutMs(payload.timeoutMs);
  const { pathname, query } = splitPathAndQuery(rawPath);

  const direct = await timeoutAfter(
    handleDirectCoreRoute(backend, method, rawPath, payload),
    timeoutMs,
    `${method} ${pathname}`,
  );
  if (isTimeoutMarker(direct)) {
    return timeoutResponse(direct.label, direct.timeoutMs);
  }
  if (direct) return direct;

  // ── Canonical path: in-process dispatchRoute (no loopback hop) ──────────
  // Treats every authenticated bridge call as authorized — the bridge is the
  // local app talking to its own runtime via a sealed native bridge, no external
  // attacker can inject frames here.
  const result = await timeoutAfter(
    dispatchRoute({
      runtime: backend.runtime,
      method,
      path: pathname,
      headers,
      query,
      body: payloadBodyAsRaw(payload),
      inProcess: true,
      isAuthorized: () => true,
    }),
    timeoutMs,
    `${method} ${pathname}`,
  );

  if (isTimeoutMarker(result)) {
    return timeoutResponse(result.label, result.timeoutMs);
  }

  if (result) {
    const responseHeaders = result.headers ?? {};
    let bodyBytes: Buffer;
    if (result.body == null) {
      bodyBytes = Buffer.alloc(0);
    } else if (typeof result.body === "string") {
      bodyBytes = Buffer.from(result.body, "utf8");
    } else if (Buffer.isBuffer(result.body)) {
      bodyBytes = result.body;
    } else if (result.body instanceof Uint8Array) {
      bodyBytes = Buffer.from(result.body);
    } else {
      bodyBytes = Buffer.from(JSON.stringify(result.body), "utf8");
      if (
        !Object.keys(responseHeaders).some(
          (k) => k.toLowerCase() === "content-type",
        )
      ) {
        responseHeaders["content-type"] = "application/json; charset=utf-8";
      }
    }
    return {
      status: result.status,
      statusText: statusTextForCode(result.status),
      headers: responseHeaders,
      body: bodyBytes.toString("utf8"),
      bodyBase64: bodyBytes.toString("base64"),
      bodyEncoding: "utf-8",
    };
  }

  return jsonResponse(404, {
    error: `No iOS local route for ${method} ${pathname}`,
    code: "not_found",
  });
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function jsonResponse(
  status: number,
  body: unknown,
): BufferedHttpResponse {
  const text = JSON.stringify(body);
  return {
    status,
    statusText: statusTextForCode(status),
    headers: { "content-type": "application/json; charset=utf-8" },
    body: text,
    bodyBase64: Buffer.from(text, "utf8").toString("base64"),
    bodyEncoding: "utf-8",
  };
}

function buildBufferedRoutePair(args: {
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyText: string;
}): {
  req: IncomingMessage;
  res: ServerResponse;
  captured: {
    statusCode: number;
    headers: Record<string, string>;
    chunks: Buffer[];
    ended: boolean;
  };
} {
  const readable = Readable.from(
    args.bodyText ? [Buffer.from(args.bodyText, "utf8")] : [],
  );
  const req = readable as unknown as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = args.method;
  req.url = args.path;
  req.headers = args.headers;

  const captured = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    chunks: [] as Buffer[],
    ended: false,
  };
  const writeChunk = (chunk: unknown): void => {
    if (chunk == null) return;
    if (typeof chunk === "string") {
      captured.chunks.push(Buffer.from(chunk, "utf8"));
    } else if (Buffer.isBuffer(chunk)) {
      captured.chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      captured.chunks.push(Buffer.from(chunk));
    } else {
      captured.chunks.push(Buffer.from(String(chunk), "utf8"));
    }
  };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(value: number) {
      captured.statusCode = value;
    },
    get headersSent() {
      return captured.ended;
    },
    setHeader(name: string, value: string | number | string[]) {
      captured.headers[name.toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : String(value);
      return res;
    },
    getHeader(name: string) {
      return captured.headers[name.toLowerCase()];
    },
    writeHead(statusCode: number, headers?: Record<string, unknown>) {
      captured.statusCode = statusCode;
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          if (value == null) continue;
          captured.headers[key.toLowerCase()] = Array.isArray(value)
            ? value.join(", ")
            : String(value);
        }
      }
      return res;
    },
    write(chunk: unknown) {
      writeChunk(chunk);
      return true;
    },
    end(chunk?: unknown) {
      if (chunk != null) writeChunk(chunk);
      captured.ended = true;
      return res;
    },
  };
  return {
    req,
    res: res as unknown as ServerResponse,
    captured,
  };
}

function bufferedRouteResponse(captured: {
  statusCode: number;
  headers: Record<string, string>;
  chunks: Buffer[];
}): BufferedHttpResponse {
  const bytes = Buffer.concat(captured.chunks);
  return {
    status: captured.statusCode || 200,
    statusText: statusTextForCode(captured.statusCode || 200),
    headers: captured.headers,
    body: bytes.toString("utf8"),
    bodyBase64: bytes.toString("base64"),
    bodyEncoding: "utf-8",
  };
}

function runtimeAgentName(runtime: IAgentRuntime): string {
  const character = (runtime as { character?: { name?: unknown } }).character;
  return typeof character?.name === "string" && character.name.trim()
    ? character.name.trim()
    : "Eliza";
}

function parseRequestBody(payload: HttpRequestPayload): Record<string, unknown> {
  const raw = payloadBodyAsRaw(payload);
  if (!raw) return {};
  if (Buffer.isBuffer(raw)) {
    const parsed = parseJsonBody(raw.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }
  if (typeof raw === "string") {
    const parsed = parseJsonBody(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  }
  return typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function createIosConversation(
  backend: IosBridgeBackend,
  input: Record<string, unknown> = {},
): IosConversation {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const metadata =
    input.metadata &&
    typeof input.metadata === "object" &&
    !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : undefined;
  const conversation: IosConversation = {
    id,
    title:
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim()
        : "New Chat",
    roomId: stringToUuid(`ios-conv-${id}`) as UUID,
    createdAt: now,
    updatedAt: now,
    ...(metadata ? { metadata } : {}),
  };
  backend.conversations.set(id, conversation);
  return conversation;
}

async function ensureConversationConnection(
  backend: IosBridgeBackend,
  conversation: IosConversation,
): Promise<UUID> {
  const runtime = backend.runtime as IAgentRuntime & {
    ensureConnection?: (args: Record<string, unknown>) => Promise<void> | void;
  };
  const userId = stringToUuid("ios-local-user") as UUID;
  if (typeof runtime.ensureConnection === "function") {
    await runtime.ensureConnection({
      entityId: userId,
      roomId: conversation.roomId,
      worldId: stringToUuid("ios-local-world") as UUID,
      userName: "User",
      source: "ios-local",
      channelId: "ios-local-chat",
      type: ChannelType.DM,
      messageServerId: stringToUuid("ios-local-server") as UUID,
      metadata: { ownership: { ownerId: userId } },
    });
  }
  return userId;
}

async function handleDirectConversationMessage(
  backend: IosBridgeBackend,
  conversation: IosConversation,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prompt =
    typeof input.text === "string"
      ? input.text
      : typeof input.message === "string"
        ? input.message
        : typeof input.prompt === "string"
          ? input.prompt
          : "";
  if (!prompt.trim()) throw new Error("message text is required");

  const runtime = backend.runtime as IAgentRuntime & {
    createMemory?: (
      memory: ReturnType<typeof createMessageMemory>,
      tableName: string,
    ) => Promise<void> | void;
    messageService?: RuntimeMessageService;
  };
  const userId = await ensureConversationConnection(backend, conversation);
  const channelType =
    typeof input.channelType === "string" &&
    Object.values(ChannelType).includes(input.channelType as ChannelType)
      ? (input.channelType as ChannelType)
      : ChannelType.DM;
  const metadata =
    input.metadata &&
    typeof input.metadata === "object" &&
    !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : undefined;
  const message = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: userId,
    roomId: conversation.roomId,
    content: {
      text: prompt,
      source: "ios-local",
      channelType,
      ...(metadata ? { metadata: metadata as never } : {}),
    },
  });

  try {
    await runtime.createMemory?.(message, "messages");
  } catch {
    // Best effort. Some adapters persist inside messageService.
  }

  if (!runtime.messageService?.handleMessage) {
    throw new Error("runtime.messageService is not available");
  }

  const chunks: string[] = [];
  try {
    await runtime.messageService.handleMessage(runtime, message, async (content) => {
      if (content?.text) chunks.push(content.text);
      return [];
    });
  } catch (err) {
    chunks.push(
      err instanceof Error
        ? `The local agent started, but generation is unavailable: ${err.message}`
        : "The local agent started, but generation is unavailable.",
    );
  }

  const text = chunks.join("").trim();
  conversation.updatedAt = new Date().toISOString();
  return {
    text,
    reply: text,
    agentName: runtimeAgentName(backend.runtime),
    conversationId: conversation.id,
  };
}

async function handleDirectCoreRoute(
  backend: IosBridgeBackend,
  method: string,
  rawPath: string,
  payload: HttpRequestPayload,
): Promise<ReturnType<typeof jsonResponse> | null> {
  const { pathname } = splitPathAndQuery(rawPath);

  if (method === "GET" && pathname === "/api/health") {
    return jsonResponse(200, {
      ready: true,
      runtime: "ok",
      database: "ok",
      plugins: {
        loaded: Array.isArray((backend.runtime as { plugins?: unknown }).plugins)
          ? ((backend.runtime as { plugins?: unknown[] }).plugins?.length ?? 0)
          : 0,
        failed: 0,
      },
      coordinator: "not_wired",
      agentState: "running",
      agentName: runtimeAgentName(backend.runtime),
      startedAt: null,
      uptime: 0,
      iosBridge: "bun",
    });
  }

  if (method === "GET" && pathname === "/api/conversations") {
    return jsonResponse(200, {
      conversations: Array.from(backend.conversations.values()).sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    });
  }

  if (method === "POST" && pathname === "/api/conversations") {
    const conversation = createIosConversation(
      backend,
      parseRequestBody(payload),
    );
    return jsonResponse(200, { conversation });
  }

  const messageMatch = pathname.match(
    /^\/api\/conversations\/([^/]+)\/messages$/,
  );
  if (method === "GET" && messageMatch) {
    return jsonResponse(200, { messages: [] });
  }
  if (method === "POST" && messageMatch) {
    const conversationId = decodeURIComponent(messageMatch[1] ?? "");
    const conversation = backend.conversations.get(conversationId);
    if (!conversation) {
      return jsonResponse(404, { error: "Conversation not found" });
    }
    const result = await handleDirectConversationMessage(
      backend,
      conversation,
      parseRequestBody(payload),
    );
    return jsonResponse(200, result);
  }

  return null;
}

async function sendMessage(
  backend: IosBridgeBackend,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const input =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const message = typeof input.message === "string" ? input.message : "";
  if (!message.trim()) throw new Error("send_message requires message");

  let conversationId =
    typeof input.conversationId === "string" && input.conversationId.trim()
      ? input.conversationId.trim()
      : "";

  if (!conversationId) {
    conversationId = createIosConversation(backend, {
      title: "iOS Local Chat",
    }).id;
  }

  const conversation = backend.conversations.get(conversationId);
  if (!conversation) throw new Error("Conversation not found");

  const result = await timeoutAfter(
    handleDirectConversationMessage(backend, conversation, {
      text: message,
      channelType:
        typeof input.channelType === "string" ? input.channelType : "DM",
      ...(input.metadata &&
      typeof input.metadata === "object" &&
      !Array.isArray(input.metadata)
        ? { metadata: input.metadata }
        : {}),
    }),
    bridgeTimeoutMs(input.timeoutMs),
    "send_message",
  );
  if (isTimeoutMarker(result)) {
    throw new Error(`${result.label} timed out after ${result.timeoutMs}ms`);
  }
  return { ...result, conversationId, response: result };
}

async function dispatchBridgeRequest(
  host: IosBridgeHost,
  request: BridgeRequest,
): Promise<unknown> {
  const method = typeof request.method === "string" ? request.method : "";
  const payload =
    request.payload && typeof request.payload === "object"
      ? (request.payload as Record<string, unknown>)
      : {};
  switch (method) {
    case "status":
      if (host.backend) {
        return { ready: true, apiPort: host.backend.fallbackPort };
      }
      if (host.bootError) {
        return {
          ready: false,
          phase: "error",
          error:
            host.bootError instanceof Error
              ? host.bootError.message
            : String(host.bootError),
        };
      }
      if (payload.timeoutMs !== undefined) {
        const backend = await awaitIosBridgeBackend(
          host,
          bridgeTimeoutMs(payload.timeoutMs),
          "status",
        );
        return { ready: true, apiPort: backend.fallbackPort };
      }
      return { ready: false, phase: "starting", apiPort: 0 };
    case "http_request":
    case "http_fetch":
      const backendForFetch = await awaitIosBridgeBackend(
        host,
        bridgeTimeoutMs(payload.timeoutMs),
        method,
      );
      return fetchBackend(
        backendForFetch,
        (request.payload ?? {}) as HttpRequestPayload,
      );
    case "send_message":
      const backendForMessage = await awaitIosBridgeBackend(
        host,
        bridgeTimeoutMs(payload.timeoutMs),
        method,
      );
      return sendMessage(backendForMessage, request.payload);
    default:
      throw new Error(`Unknown iOS bridge method: ${method || "(missing)"}`);
  }
}

function reserveStdoutForBridgeProtocol(): () => void {
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalConsoleLog = console.log.bind(console);
  const originalConsoleInfo = console.info.bind(console);
  const originalConsoleDebug = console.debug.bind(console);

  const writeToStderr = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean => {
    if (typeof encoding === "function") {
      return stderrWrite(chunk, encoding);
    }
    if (encoding) {
      return cb
        ? stderrWrite(chunk, encoding, cb)
        : stderrWrite(chunk, encoding);
    }
    return cb ? stderrWrite(chunk, cb) : stderrWrite(chunk);
  };

  process.stdout.write = ((
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    return writeToStderr(
      chunk as string | Uint8Array,
      encoding as BufferEncoding,
      cb as ((err?: Error) => void) | undefined,
    );
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => console.error(...args);
  console.info = (...args: unknown[]) => console.error(...args);
  console.debug = (...args: unknown[]) => console.error(...args);

  return () => {
    process.stdout.write = originalStdoutWrite;
    console.log = originalConsoleLog;
    console.info = originalConsoleInfo;
    console.debug = originalConsoleDebug;
  };
}

export async function runIosBridgeCli(
  argv: string[] = process.argv,
): Promise<void> {
  if (!argv.includes("--stdio")) {
    throw new Error("ios-bridge currently supports --stdio only");
  }

  const protocolWrite = process.stdout.write.bind(process.stdout);
  const restoreStdout = reserveStdoutForBridgeProtocol();
  const writeProtocolLine = (value: BridgeFrame) => {
    protocolWrite(`${JSON.stringify(value)}\n`);
  };

  const host = startIosBridgeHost();
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[ios-bridge] unhandled rejection:",
      reason instanceof Error ? reason.stack || reason.message : reason,
    );
  });
  process.on("uncaughtException", (error) => {
    console.error("[ios-bridge] uncaught exception:", error.stack || error.message);
  });
  writeProtocolLine({
    type: "ready",
    ok: true,
    result: { ready: true, apiPort: 0 },
  });

  const shutdown = async () => {
    try {
      if (host.backend) {
        await host.backend.close();
      }
    } catch {
      // Best effort during app shutdown.
    }
  };
  let stopBridge: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => {
    stopBridge = resolve;
  });
  process.once("SIGINT", () => stopBridge?.());
  process.once("SIGTERM", () => stopBridge?.());

  const keepAlive = setInterval(() => {
    // Bun's iOS stdio does not always keep the JS event loop alive while a
    // native pipe is idle. The bridge is host-owned and exits when the app
    // tears down the engine, so this timer intentionally keeps the process up.
  }, 2_147_483_647);

  const handleLine = async (line: string) => {
    if (!line.trim()) return;
    let parsed: BridgeRequest;
    try {
      parsed = JSON.parse(line) as BridgeRequest;
    } catch (err) {
      writeProtocolLine({
        id: null,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const id = parsed.id ?? null;
    try {
      const result = await dispatchBridgeRequest(host, parsed);
      writeProtocolLine({ id, ok: true, result });
    } catch (err) {
      writeProtocolLine({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  let pending = Promise.resolve();
  let bufferedInput = "";
  const stdin = process.stdin as typeof process.stdin & {
    setEncoding?: (encoding: BufferEncoding) => void;
    resume?: () => void;
  };
  stdin.setEncoding?.("utf8");
  stdin.on("data", (chunk: Buffer | string) => {
    bufferedInput += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const newline = bufferedInput.indexOf("\n");
      if (newline < 0) break;
      const line = bufferedInput.slice(0, newline).replace(/\r$/, "");
      bufferedInput = bufferedInput.slice(newline + 1);
      pending = pending.then(() => handleLine(line)).catch((err) => {
        writeProtocolLine({
          id: null,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });
  stdin.once("end", () => {
    if (bufferedInput.trim()) {
      const line = bufferedInput;
      bufferedInput = "";
      pending = pending.then(() => handleLine(line));
    }
    stopBridge?.();
  });
  stdin.once("error", (err) => {
    writeProtocolLine({
      id: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    stopBridge?.();
  });
  stdin.resume?.();

  await stopPromise;
  clearInterval(keepAlive);
  await pending.catch(() => undefined);

  restoreStdout();
  await shutdown();
}
