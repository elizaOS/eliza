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

function timeoutResponse(
  label: string,
  timeoutMs: number,
): {
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

function jsonResponse(status: number, body: unknown): BufferedHttpResponse {
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

function parseRequestBody(
  payload: HttpRequestPayload,
): Record<string, unknown> {
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

function installHostCallProtocol(
  write: (frame: BridgeOutboundFrame) => void,
): void {
  hostProtocolWrite = write;
}

function tryHandleHostResultLine(line: string): boolean {
  if (!line.includes('"host_result"')) return false;
  let parsed: HostResultFrame;
  try {
    parsed = JSON.parse(line) as HostResultFrame;
  } catch {
    return false;
  }
  if (parsed.type !== "host_result" || typeof parsed.id !== "string") {
    return false;
  }
  const pending = pendingHostCalls.get(parsed.id);
  if (!pending) return true;
  pendingHostCalls.delete(parsed.id);
  clearTimeout(pending.timeout);
  const envelope =
    parsed.envelope && typeof parsed.envelope === "object"
      ? (parsed.envelope as Record<string, unknown>)
      : (parsed as unknown as Record<string, unknown>);
  if (envelope.ok === false) {
    pending.reject(
      new Error(
        typeof envelope.error === "string"
          ? envelope.error
          : "Native host call failed",
      ),
    );
    return true;
  }
  pending.resolve(envelope.result);
  return true;
}

function callIosHost(
  method: string,
  payload: unknown,
  timeoutMs = 120_000,
): Promise<unknown> {
  if (!hostProtocolWrite) {
    return Promise.reject(
      new Error("iOS native host-call protocol is not installed"),
    );
  }
  const id = `host-${nextHostCallId++}`;
  const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, 30 * 60_000));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingHostCalls.delete(id);
      reject(
        new Error(
          `Native iOS host call ${method} timed out after ${boundedTimeout}ms`,
        ),
      );
    }, boundedTimeout);
    pendingHostCalls.set(id, { resolve, reject, timeout });
    hostProtocolWrite({
      type: "host_call",
      id,
      method,
      payload,
      timeoutMs: boundedTimeout,
    });
  });
}

function resolveMobileStateDir(): string {
  const explicit =
    process.env.ELIZA_STATE_DIR ||
    process.env.MILADY_STATE_DIR ||
    process.env.ELIZA_HOME;
  if (explicit?.trim()) return explicit.trim();
  if (process.env.HOME?.trim()) {
    return path.join(process.env.HOME.trim(), ".eliza");
  }
  return "/tmp/eliza";
}

function localInferenceRootPath(): string {
  return path.join(resolveMobileStateDir(), "local-inference");
}

function localInferenceRegistryPath(): string {
  return path.join(localInferenceRootPath(), "registry.json");
}

function localInferenceAssignmentsPath(): string {
  return path.join(localInferenceRootPath(), "assignments.json");
}

function localInferenceRoutingPath(): string {
  return path.join(localInferenceRootPath(), "routing.json");
}

function readJsonObjectFile(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return null;
}

function readAssignments(): Record<string, string> {
  const parsed = readJsonObjectFile(localInferenceAssignmentsPath());
  const raw = parsed.assignments;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [slot, modelId] of Object.entries(raw)) {
    if (typeof modelId === "string" && modelId.trim()) {
      out[slot] = modelId.trim();
    }
  }
  return out;
}

function scanGgufFiles(root: string): InstalledModelEntry[] {
  const models: InstalledModelEntry[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 5 || models.length >= 200) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        visit(fullPath, depth + 1);
      } else if (stats.isFile() && entry.toLowerCase().endsWith(".gguf")) {
        const id = path.basename(entry, path.extname(entry));
        models.push({
          id,
          displayName: id,
          path: fullPath,
          sizeBytes: stats.size,
          installedAt: new Date(stats.mtimeMs).toISOString(),
          lastUsedAt: null,
          source: "external-scan",
        });
      }
    }
  };
  visit(root, 0);
  return models;
}

function readInstalledModels(): InstalledModelEntry[] {
  const parsed = readJsonObjectFile(localInferenceRegistryPath());
  const rawModels = Array.isArray(parsed.models) ? parsed.models : [];
  const fromRegistry = rawModels
    .map((entry): InstalledModelEntry | null => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.path !== "string") {
        return null;
      }
      if (!existsSync(record.path)) return null;
      return {
        id: record.id,
        displayName:
          typeof record.displayName === "string"
            ? record.displayName
            : record.id,
        path: record.path,
        sizeBytes: positiveInteger(record.sizeBytes) ?? 0,
        installedAt:
          typeof record.installedAt === "string"
            ? record.installedAt
            : new Date().toISOString(),
        lastUsedAt:
          typeof record.lastUsedAt === "string" ? record.lastUsedAt : null,
        source: typeof record.source === "string" ? record.source : undefined,
        bundleVerifiedAt:
          typeof record.bundleVerifiedAt === "string"
            ? record.bundleVerifiedAt
            : undefined,
        dimensions: positiveInteger(record.dimensions) ?? undefined,
        embeddingDimension:
          positiveInteger(record.embeddingDimension) ?? undefined,
        embeddingDimensions:
          positiveInteger(record.embeddingDimensions) ?? undefined,
      };
    })
    .filter((entry): entry is InstalledModelEntry => Boolean(entry));
  if (fromRegistry.length > 0) return fromRegistry;
  return scanGgufFiles(path.join(localInferenceRootPath(), "models"));
}

function isEmbeddingModel(model: InstalledModelEntry): boolean {
  const lowered = model.id.toLowerCase();
  return (
    lowered.includes("embed") ||
    lowered.includes("bge-") ||
    lowered.includes("nomic") ||
    lowered.includes("gte-") ||
    lowered.includes("e5-")
  );
}

function resolveAssignedModel(slot: string): InstalledModelEntry | null {
  const installed = readInstalledModels().filter(
    (model) => !isEmbeddingModel(model),
  );
  const assignments = readAssignments();
  const assigned = assignments[slot];
  if (assigned) {
    const model = installed.find((entry) => entry.id === assigned);
    if (model) return model;
  }
  if (nativeLlamaState.modelPath) {
    const current = installed.find(
      (entry) => entry.path === nativeLlamaState.modelPath,
    );
    if (current) return current;
  }
  return (
    installed.sort((left, right) => {
      const leftUsed = left.lastUsedAt ? Date.parse(left.lastUsedAt) : 0;
      const rightUsed = right.lastUsedAt ? Date.parse(right.lastUsedAt) : 0;
      if (rightUsed !== leftUsed) return rightUsed - leftUsed;
      return (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0);
    })[0] ?? null
  );
}

function nativeLlamaContextSize(): number {
  return (
    positiveInteger(process.env.ELIZA_IOS_LLAMA_CONTEXT_SIZE) ??
    positiveInteger(process.env.MILADY_IOS_LLAMA_CONTEXT_SIZE) ??
    positiveInteger(process.env.ELIZA_LOCAL_CONTEXT_SIZE) ??
    4096
  );
}

async function ensureNativeModelLoaded(
  slot: string,
): Promise<NativeLlamaState> {
  const model = resolveAssignedModel(slot);
  if (!model) {
    throw new Error(
      `[ios-native-llama] No local GGUF model is installed under ${path.join(
        localInferenceRootPath(),
        "models",
      )}. Download or install a model before using local generation.`,
    );
  }
  if (
    nativeLlamaState.contextId != null &&
    nativeLlamaState.modelPath === model.path &&
    nativeLlamaState.status === "ready"
  ) {
    return nativeLlamaState;
  }

  await unloadNativeLlamaModel();
  nativeLlamaState.status = "loading";
  nativeLlamaState.modelId = model.id;
  nativeLlamaState.modelPath = model.path;
  nativeLlamaState.loadedAt = null;
  delete nativeLlamaState.error;
  try {
    const result = await callIosHost(
      "llama_load_model",
      {
        path: model.path,
        modelId: model.id,
        context_size: nativeLlamaContextSize(),
        use_gpu: process.env.ELIZA_IOS_LLAMA_USE_GPU !== "0",
      },
      10 * 60_000,
    );
    const record =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {};
    const contextId =
      positiveInteger(record.context_id) ?? positiveInteger(record.contextId);
    if (contextId == null) {
      throw new Error("Native llama load returned no context_id");
    }
    nativeLlamaState.contextId = contextId;
    nativeLlamaState.loadedAt = new Date().toISOString();
    nativeLlamaState.status = "ready";
    return nativeLlamaState;
  } catch (error) {
    nativeLlamaState.contextId = null;
    nativeLlamaState.loadedAt = null;
    nativeLlamaState.status = "error";
    nativeLlamaState.error =
      error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function unloadNativeLlamaModel(): Promise<void> {
  const contextId = nativeLlamaState.contextId;
  nativeLlamaState.contextId = null;
  nativeLlamaState.loadedAt = null;
  nativeLlamaState.status = "idle";
  if (contextId != null) {
    await callIosHost("llama_free", { context_id: contextId }, 30_000).catch(
      () => undefined,
    );
  }
  nativeLlamaState.modelId = null;
  nativeLlamaState.modelPath = null;
  delete nativeLlamaState.error;
}

function flattenChatParamsForPrompt(params: GenerateTextParams): string {
  if (typeof params.prompt === "string" && params.prompt.length > 0) {
    return params.prompt;
  }
  const blocks: string[] = [];
  const messages = params.messages ?? [];
  const hasSystemMessage = messages.some(
    (message) => message.role === "system",
  );
  if (!hasSystemMessage && typeof params.system === "string" && params.system) {
    blocks.push(`system:\n${params.system}`);
  }
  for (const message of messages) {
    const role =
      message.role === "system" ||
      message.role === "assistant" ||
      message.role === "tool"
        ? message.role
        : "user";
    if (typeof message.content === "string") {
      if (message.content) blocks.push(`${role}:\n${message.content}`);
      continue;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) blocks.push(`${role}:\n${text}`);
    }
  }
  blocks.push("assistant:");
  return blocks.join("\n\n");
}

function makeIosNativeGenerateHandler(slot: string): GenerateTextHandler {
  return async (_runtime, params) => {
    const state = await ensureNativeModelLoaded(slot);
    if (state.contextId == null) {
      throw new Error(
        "[ios-native-llama] model load did not produce a context",
      );
    }
    const prompt = flattenChatParamsForPrompt(params);
    const result = await callIosHost(
      "llama_generate",
      {
        context_id: state.contextId,
        prompt,
        max_tokens: positiveInteger(params.maxTokens) ?? 256,
        temperature:
          typeof params.temperature === "number" ? params.temperature : 0.7,
        top_p: typeof params.topP === "number" ? params.topP : 0.95,
        top_k: positiveInteger(params.topK) ?? 40,
        stop: params.stopSequences ?? [],
      },
      Math.max(120_000, (positiveInteger(params.maxTokens) ?? 256) * 2_000),
    );
    const record =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : {};
    const text =
      typeof record.text === "string" ? record.text : String(result ?? "");
    if (params.onStreamChunk && text) {
      await params.onStreamChunk(text, crypto.randomUUID(), text);
    }
    return text;
  };
}

function installIosNativeLlamaHandlers(runtime: IAgentRuntime): void {
  const flagged = runtime as IAgentRuntime & {
    __iosNativeLlamaHandlersInstalled?: boolean;
  };
  if (flagged.__iosNativeLlamaHandlersInstalled) return;
  const runtimeWithRegistration = runtime as RuntimeWithModelRegistration;
  if (typeof runtimeWithRegistration.registerModel !== "function") return;
  for (const modelType of TEXT_GENERATION_MODEL_TYPES) {
    runtimeWithRegistration.registerModel(
      modelType,
      makeIosNativeGenerateHandler(modelType),
      IOS_NATIVE_LLAMA_PROVIDER,
      IOS_NATIVE_LLAMA_PRIORITY,
    );
  }
  flagged.__iosNativeLlamaHandlersInstalled = true;
}

async function nativeHardwareInfo(): Promise<Record<string, unknown>> {
  try {
    const result = await callIosHost("llama_hardware_info", {}, 10_000);
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  } catch (error) {
    return {
      backend: "unknown",
      total_ram_gb: 0,
      available_ram_gb: 0,
      cpu_cores: 0,
      is_simulator: process.env.SIMULATOR_DEVICE_NAME ? true : undefined,
      metal_supported: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function nativeLlamaDeviceStatus(): Promise<Record<string, unknown>> {
  const hardware = await nativeHardwareInfo();
  const totalRamGb = Number(hardware.total_ram_gb ?? 0);
  const cpuCores = Number(hardware.cpu_cores ?? 0);
  const metalSupported = hardware.metal_supported === true;
  return {
    enabled: true,
    connected: true,
    transport: "bun-host-ipc",
    devices: [
      {
        deviceId: IOS_NATIVE_LLAMA_DEVICE_ID,
        capabilities: {
          platform: "ios",
          deviceModel:
            hardware.is_simulator === true ? "iOS Simulator" : "iOS Device",
          totalRamGb,
          cpuCores,
          gpu: {
            backend: "metal",
            available: metalSupported,
          },
        },
        loadedPath: nativeLlamaState.modelPath,
        connectedSince: nativeLlamaState.loadedAt ?? new Date().toISOString(),
      },
    ],
    primaryDeviceId: IOS_NATIVE_LLAMA_DEVICE_ID,
    pendingRequests: pendingHostCalls.size,
    modelPath: nativeLlamaState.modelPath,
  };
}

function nativeLlamaActiveSnapshot(): Record<string, unknown> {
  return {
    modelId: nativeLlamaState.modelId,
    modelPath: nativeLlamaState.modelPath,
    loadedAt: nativeLlamaState.loadedAt,
    status: nativeLlamaState.status,
    provider: IOS_NATIVE_LLAMA_PROVIDER,
    transport: "bun-host-ipc",
    ...(nativeLlamaState.error ? { error: nativeLlamaState.error } : {}),
  };
}

async function nativeLocalInferenceProviders(): Promise<
  Record<string, unknown>
> {
  const installed = readInstalledModels();
  return {
    providers: [
      {
        id: IOS_NATIVE_LLAMA_PROVIDER,
        label: "Eliza-1 on-device runtime (iOS)",
        kind: "local",
        description:
          "Runs Eliza-1 natively through the full Bun host IPC bridge.",
        supportedSlots: ["TEXT_SMALL", "TEXT_LARGE"],
        configureHref: null,
        enableState: {
          enabled: true,
          reason: "Native iOS llama bridge connected",
        },
        registeredSlots: ["TEXT_SMALL", "TEXT_LARGE"],
        transport: "bun-host-ipc",
      },
      {
        id: "eliza-local-inference",
        label: "Eliza-1 local inference",
        kind: "local",
        description: "Eliza-1 bundles installed in this agent state directory.",
        supportedSlots: ["TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING"],
        configureHref: "#local-inference-panel",
        enableState: {
          enabled: installed.length > 0,
          reason:
            installed.length > 0
              ? "Eliza-1 bundle installed"
              : "No Eliza-1 bundle installed",
        },
        registeredSlots:
          installed.length > 0 ? ["TEXT_SMALL", "TEXT_LARGE"] : [],
      },
    ],
  };
}

function routingPreferencesSnapshot(): Record<string, unknown> {
  const parsed = readJsonObjectFile(localInferenceRoutingPath());
  const preferences =
    parsed.preferences && typeof parsed.preferences === "object"
      ? (parsed.preferences as Record<string, unknown>)
      : { preferredProvider: {}, policy: {} };
  return {
    registrations: ["TEXT_SMALL", "TEXT_LARGE"].map((modelType) => ({
      modelType,
      provider: IOS_NATIVE_LLAMA_PROVIDER,
      priority: IOS_NATIVE_LLAMA_PRIORITY,
      registeredAt: new Date().toISOString(),
    })),
    preferences,
  };
}

async function nativeHubSnapshot(
  legacy: BufferedHttpResponse | null,
): Promise<Record<string, unknown>> {
  const base =
    legacy && legacy.status >= 200 && legacy.status < 300
      ? parseJsonBody(legacy.body)
      : {};
  const object =
    base && typeof base === "object" && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : {};
  const hardware = await nativeHardwareInfo();
  return {
    ...object,
    installed: readInstalledModels(),
    active: nativeLlamaActiveSnapshot(),
    device: await nativeLlamaDeviceStatus(),
    providers: (await nativeLocalInferenceProviders()).providers,
    hardware: {
      totalRamGb: Number(hardware.total_ram_gb ?? 0),
      freeRamGb: Number(hardware.available_ram_gb ?? 0),
      gpu: {
        backend: "metal",
        available: hardware.metal_supported === true,
      },
      cpuCores: Number(hardware.cpu_cores ?? 0),
      platform: "ios",
      arch: hardware.is_simulator === true ? "simulator" : "arm64",
      appleSilicon: hardware.metal_supported === true,
      recommendedBucket: "small",
      source: "ios-native-llama",
    },
    assignments: readAssignments(),
  };
}

async function runBufferedLegacyLocalInferenceRoute(
  method: string,
  rawPath: string,
  payload: HttpRequestPayload,
): Promise<BufferedHttpResponse | null> {
  const { handleLocalInferenceRoutes } = await import(
    "@elizaos/plugin-local-inference"
  );
  const headers = normalizeHeaderRecord(payload.headers);
  const { req, res, captured } = buildBufferedRoutePair({
    method,
    path: rawPath,
    headers,
    bodyText: bodyTextForLegacyRoute(payload),
  });

  const handled = await handleLocalInferenceRoutes(req, res);
  if (!handled) return null;
  return bufferedRouteResponse(captured);
}

async function handleNativeIosLocalInferenceRoute(
  method: string,
  rawPath: string,
  payload: HttpRequestPayload,
  legacy: () => Promise<BufferedHttpResponse | null>,
): Promise<BufferedHttpResponse | null> {
  const { pathname } = splitPathAndQuery(rawPath);
  if (method === "GET" && pathname === "/api/local-inference/device") {
    return jsonResponse(200, await nativeLlamaDeviceStatus());
  }
  if (method === "GET" && pathname === "/api/local-inference/providers") {
    return jsonResponse(200, await nativeLocalInferenceProviders());
  }
  if (method === "GET" && pathname === "/api/local-inference/hardware") {
    return jsonResponse(200, (await nativeHubSnapshot(null)).hardware);
  }
  if (method === "GET" && pathname === "/api/local-inference/routing") {
    return jsonResponse(200, routingPreferencesSnapshot());
  }
  if (method === "GET" && pathname === "/api/local-inference/active") {
    return jsonResponse(200, nativeLlamaActiveSnapshot());
  }
  if (method === "POST" && pathname === "/api/local-inference/active") {
    const body = parseRequestBody(payload);
    const modelId = typeof body.modelId === "string" ? body.modelId : "";
    const installed = readInstalledModels();
    const target = installed.find((model) => model.id === modelId);
    if (!target) {
      return jsonResponse(404, { error: `Model not installed: ${modelId}` });
    }
    mkdirSync(localInferenceRootPath(), { recursive: true });
    nativeLlamaState.modelId = target.id;
    nativeLlamaState.modelPath = target.path;
    await ensureNativeModelLoaded("TEXT_SMALL");
    return jsonResponse(200, nativeLlamaActiveSnapshot());
  }
  if (method === "DELETE" && pathname === "/api/local-inference/active") {
    await unloadNativeLlamaModel();
    return jsonResponse(200, nativeLlamaActiveSnapshot());
  }
  if (method === "GET" && pathname === "/api/local-inference/hub") {
    return jsonResponse(200, await nativeHubSnapshot(await legacy()));
  }
  return null;
}

async function handleBufferedLocalInferenceRoute(
  method: string,
  rawPath: string,
  payload: HttpRequestPayload,
): Promise<BufferedHttpResponse | null> {
  const { pathname } = splitPathAndQuery(rawPath);
  if (!pathname.startsWith("/api/local-inference/")) return null;

  if (
    method === "GET" &&
    (pathname === "/api/local-inference/downloads/stream" ||
      pathname === "/api/local-inference/device/stream")
  ) {
    return jsonResponse(501, {
      error:
        "Streaming local-inference endpoints are not available over the iOS stdio bridge",
      code: "streaming_not_supported",
    });
  }

  const runLegacy = async () =>
    runBufferedLegacyLocalInferenceRoute(method, rawPath, payload);
  const native = await handleNativeIosLocalInferenceRoute(
    method,
    rawPath,
    payload,
    runLegacy,
  );
  if (native) return native;
  return runLegacy();
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
    await runtime.messageService.handleMessage(
      runtime,
      message,
      async (content) => {
        if (content?.text) chunks.push(content.text);
        return [];
      },
    );
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
        loaded: Array.isArray(
          (backend.runtime as { plugins?: unknown }).plugins,
        )
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

  const localInference = await handleBufferedLocalInferenceRoute(
    method,
    rawPath,
    payload,
  );
  if (localInference) return localInference;

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
    case "http_fetch": {
      const backendForFetch = await awaitIosBridgeBackend(
        host,
        bridgeTimeoutMs(payload.timeoutMs),
        method,
      );
      return fetchBackend(
        backendForFetch,
        (request.payload ?? {}) as HttpRequestPayload,
      );
    }
    case "send_message": {
      const backendForMessage = await awaitIosBridgeBackend(
        host,
        bridgeTimeoutMs(payload.timeoutMs),
        method,
      );
      return sendMessage(backendForMessage, request.payload);
    }
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
  const writeProtocolLine = (value: BridgeOutboundFrame) => {
    protocolWrite(`${JSON.stringify(value)}\n`);
  };

  installHostCallProtocol(writeProtocolLine);
  const host = startIosBridgeHost();
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[ios-bridge] unhandled rejection:",
      reason instanceof Error ? reason.stack || reason.message : reason,
    );
  });
  process.on("uncaughtException", (error) => {
    console.error(
      "[ios-bridge] uncaught exception:",
      error.stack || error.message,
    );
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
      if (tryHandleHostResultLine(line)) continue;
      pending = pending
        .then(() => handleLine(line))
        .catch((err) => {
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
      if (!tryHandleHostResultLine(line)) {
        pending = pending.then(() => handleLine(line));
      }
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
