import { Capacitor, registerPlugin } from "@capacitor/core";
import { getElizaApiBase } from "@elizaos/shared";
import {
  handleIosLocalAgentRequest,
  startIosLocalAgentKernel,
} from "@elizaos/ui/api/ios-local-agent-kernel";
// Boot-trace + boot-progress helpers come from the @elizaos/ui transport copy
// so BOTH copies share ONE module-level progress state: the startup poll
// (packages/ui/src/state/startup-phase-poll.ts) reads that state for its
// progress-aware failure budget and must see engine phases/heartbeats no
// matter which copy serves the request (#11030).
import {
  appendIosBootTrace,
  recordIosNativeAgentBootHeartbeat,
  recordIosNativeAgentBootPhase,
} from "@elizaos/ui/api/ios-local-agent-transport";
import { createIttpAgentTransport } from "@elizaos/ui/api/ittp-agent-transport";
import type { AgentRequestTransport } from "@elizaos/ui/api/transport";
import {
  installElizaBridge,
  registerElizaBridgeCapability,
} from "@elizaos/ui/bridge/eliza-window-bridge";
import { isStoreBuild } from "@elizaos/ui/build-variant";
import {
  isMobileLocalAgentUrl as isConfiguredMobileLocalAgentUrl,
  isMobileLocalAgentIpcUrl,
  MOBILE_LOCAL_AGENT_PORT,
  mobileLocalAgentPathFromUrl,
} from "@elizaos/ui/first-run/mobile-runtime-mode";

let transport: AgentRequestTransport | null = null;
let globalRequestHandlerInstalled = false;
let globalFetchBridgeInstalled = false;
let restartRequestListenerInstalled = false;
let restartRequestInFlight: Promise<void> | null = null;
let originalFetch: typeof fetch | null = null;
let fullBunRuntime:
  | Promise<FullBunRuntimePlugin | null>
  | PrimedFullBunRuntime
  | null = null;
const IOS_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";

type FetchWithOptionalPreconnect = typeof fetch & {
  preconnect?: (...args: unknown[]) => unknown;
};

export interface IosLocalAgentNativeRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export interface IosLocalAgentNativeRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  /**
   * Lossless base64 of the raw response bytes. Preferred over `body` so binary
   * payloads (served media, generated images, TTS audio) survive the bridge.
   * Mirrors the Android transport + the @elizaos/ui copy of this transport.
   */
  bodyBase64?: string | null;
  bodyEncoding?: string;
}

interface FullBunRuntimePlugin {
  start(options: {
    engine: "bun";
    argv?: string[];
    env?: Record<string, string>;
  }): Promise<{ ok: boolean; error?: string }>;
  getStatus(): Promise<{ ready: boolean; engine?: "bun" | "compat" }>;
  call(options: {
    method: string;
    args?: unknown;
  }): Promise<{ result: unknown }>;
}

interface PrimedFullBunRuntime {
  kind: "primed";
  runtime: FullBunRuntimePlugin | null;
}

function isPrimedFullBunRuntime(
  value: typeof fullBunRuntime,
): value is PrimedFullBunRuntime {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "primed"
  );
}

interface FullBunRuntimeModule {
  ElizaBunRuntime: FullBunRuntimePlugin;
}

type IosLocalAgentRestartRequestDetail = {
  attempt?: number;
  source?: string;
};

const IOS_FULL_BUN_ARGV = [
  "bun",
  "--no-install",
  "public/agent/agent-bundle.js",
  "ios-bridge",
  "--stdio",
];

const IOS_FULL_BUN_ENV: Record<string, string> = {
  ELIZA_PLATFORM: "ios",
  ELIZA_MOBILE_PLATFORM: "ios",
  ELIZA_RUNTIME_MODE: "local-safe",
  RUNTIME_MODE: "local-safe",
  LOCAL_RUNTIME_MODE: "local-safe",
  ELIZA_IOS_LOCAL_BACKEND: "1",
  ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS: "300000",
  ELIZA_PGLITE_DISABLE_EXTENSIONS: "0",
  ELIZA_VAULT_BACKEND: "file",
  ELIZA_DISABLE_VAULT_PROFILE_RESOLVER: "1",
  ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP: "1",
  ELIZA_HEADLESS: "1",
  ELIZA_IOS_BRIDGE_TRANSPORT: "bun-host-ipc",
  LOG_LEVEL: "error",
};
const STARTUP_TRACE_ID_WINDOW_KEY = "__ELIZA_STARTUP_TRACE_ID__";
const STARTUP_TRACE_WINDOW_KEY = "__ELIZA_STARTUP_TRACE__";
const IOS_RESTART_LISTENER_WINDOW_KEY =
  "__ELIZA_IOS_LOCAL_AGENT_RESTART_LISTENER_INSTALLED__";

type ImportMetaEnvRecord = Record<string, string | boolean | undefined>;

declare global {
  interface Window {
    [STARTUP_TRACE_ID_WINDOW_KEY]?: string;
    [IOS_RESTART_LISTENER_WINDOW_KEY]?: boolean;
  }
}

function viteEnv(): ImportMetaEnvRecord {
  const metaEnv =
    (import.meta as ImportMeta & { env?: ImportMetaEnvRecord }).env ?? {};
  const processEnv = typeof process === "undefined" ? {} : process.env;
  return { ...processEnv, ...metaEnv };
}

function isTruthyBuildFlag(value: string | boolean | undefined): boolean {
  return value === true || /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function isFullBunRuntimeBuiltIn(): boolean {
  const env = viteEnv();
  return (
    isTruthyBuildFlag(env.VITE_ELIZA_IOS_FULL_BUN_AVAILABLE) ||
    isTruthyBuildFlag(env.VITE_ELIZA_IOS_FULL_BUN_STRICT) ||
    isTruthyBuildFlag(env.VITE_ELIZA_IOS_FULL_BUN_SMOKE)
  );
}

function isDevBuild(): boolean {
  const env = viteEnv();
  return (
    env.DEV === true ||
    String(env.MODE ?? "")
      .trim()
      .toLowerCase() === "development"
  );
}

function readRuntimeMode(): string | null {
  const persisted = readPersistedRuntimeMode()?.trim();
  if (persisted) return persisted;
  const env = viteEnv();
  const iosRuntimeMode =
    typeof env.VITE_ELIZA_IOS_RUNTIME_MODE === "string"
      ? env.VITE_ELIZA_IOS_RUNTIME_MODE.trim()
      : "";
  const mobileRuntimeMode =
    typeof env.VITE_ELIZA_MOBILE_RUNTIME_MODE === "string"
      ? env.VITE_ELIZA_MOBILE_RUNTIME_MODE.trim()
      : "";
  return iosRuntimeMode || mobileRuntimeMode || null;
}

function shouldRequireFullBunRuntime(): boolean {
  const env = viteEnv();
  const runtimeMode = readRuntimeMode();
  if (runtimeMode === "cloud" || runtimeMode === "cloud-hybrid") return false;
  const fullBunBuiltIn = isFullBunRuntimeBuiltIn();
  return (
    isTruthyBuildFlag(env.VITE_ELIZA_IOS_FULL_BUN_STRICT) ||
    isTruthyBuildFlag(env.VITE_ELIZA_IOS_FULL_BUN_SMOKE) ||
    hasIosFullBunSmokeRequest() ||
    (fullBunBuiltIn &&
      ((isNativeIosStoreBuild() && runtimeMode === "local") ||
        (isTruthyBuildFlag(env.PROD) && runtimeMode === "local") ||
        (isNativeIos() && !isDevBuild() && runtimeMode === "local")))
  );
}

function hasIosFullBunSmokeRequest(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem("eliza:ios-full-bun-smoke:request") ===
      "1"
    );
  } catch {
    return false;
  }
}

function readPersistedRuntimeMode(): string | null {
  try {
    return (
      globalThis.localStorage?.getItem("eliza:mobile-runtime-mode") ?? null
    );
  } catch {
    return null;
  }
}

function fullBunStartupError(message: string, cause?: unknown): Error {
  const causeMessage =
    cause instanceof Error ? cause.message : cause ? String(cause) : "";
  return new Error(
    `[ios-local-agent] Full Bun iOS runtime required but ${message}${
      causeMessage ? `: ${causeMessage}` : ""
    }`,
  );
}

function isNativeIos(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  } catch {
    return false;
  }
}

function isNativeIosStoreBuild(): boolean {
  return isNativeIos() && isStoreBuild();
}

function isNativeIosCloudRuntime(): boolean {
  if (!isNativeIos()) return false;
  const runtimeMode = readRuntimeMode();
  if (!runtimeMode && isTruthyBuildFlag(viteEnv().PROD)) return true;
  return runtimeMode === "cloud" || runtimeMode === "cloud-hybrid";
}

function isPureRemoteRuntimeMode(mode: string | null): boolean {
  return mode === "cloud";
}

function usesStrictIosNetworkPolicy(): boolean {
  return isNativeIosStoreBuild() || isNativeIosCloudRuntime();
}

function isLoopbackLocalAgentUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname || "";
    return (
      parsed.protocol === "http:" &&
      parsed.port === MOBILE_LOCAL_AGENT_PORT &&
      (hostname === "127.0.0.1" ||
        hostname.startsWith("127.") ||
        hostname === "localhost" ||
        hostname === "::1" ||
        hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function normalizeHost(host: string | null | undefined): string {
  return (host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isPrivateOrLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized) ||
    normalized.startsWith("169.254.") ||
    (normalized.includes(":") &&
      (normalized.startsWith("fe80:") ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd"))) ||
    normalized === "local" ||
    normalized === "internal" ||
    normalized === "lan" ||
    normalized === "ts.net" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".ts.net")
  );
}

function isCleartextNetworkUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "ws:";
}

function isIosLocalAgentIpcUrl(url: URL): boolean {
  return isMobileLocalAgentIpcUrl(url);
}

function isMobileLocalAgentUrl(value: string): boolean {
  return isConfiguredMobileLocalAgentUrl(value);
}

/**
 * Whether the selected iOS runtime owns an on-device agent process/runtime.
 * `cloud` is the only pure remote mode. `cloud-hybrid` still runs the bundled
 * agent while routing inference through cloud, and `tunnel-to-mobile` exposes
 * the phone-side agent through a relay for a remote client.
 */
function iosRuntimeHasOnDeviceAgent(): boolean {
  const mode = readRuntimeMode();
  return (
    mode === "local" || mode === "cloud-hybrid" || mode === "tunnel-to-mobile"
  );
}

function canUseIosLocalAgentIpc(): boolean {
  if (!isNativeIos()) return false;
  if (iosRuntimeHasOnDeviceAgent() || shouldRequireFullBunRuntime()) {
    return true;
  }
  return !usesStrictIosNetworkPolicy();
}

function localAgentPathnameFromUrl(url: URL): string {
  const path = mobileLocalAgentPathFromUrl(url);
  if (!path) return url.pathname || "/";
  const queryIndex = path.indexOf("?");
  return queryIndex >= 0 ? path.slice(0, queryIndex) || "/" : path || "/";
}

function isCloudRuntimeAllowedLocalAgentPath(path: string): boolean {
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
  return (
    pathname === "/api/local-inference" ||
    pathname.startsWith("/api/local-inference/") ||
    pathname === "/api/tts/local-inference"
  );
}

function isCloudRuntimeAllowedIpcPath(url: URL): boolean {
  if (!isNativeIosCloudRuntime()) return false;
  return isCloudRuntimeAllowedLocalAgentPath(localAgentPathnameFromUrl(url));
}

function canUseJsContextCompatibilityFallback(): boolean {
  return isNativeIos() && isDevBuild() && !isNativeIosStoreBuild();
}

function isFullBunRuntimePluginAvailable(): boolean {
  try {
    const capacitor = Capacitor as typeof Capacitor & {
      isPluginAvailable?: (name: string) => boolean;
    };
    return capacitor.isPluginAvailable?.("ElizaBunRuntime") === true;
  } catch {
    return false;
  }
}

function wrapFullBunRuntime(
  runtime: FullBunRuntimePlugin,
): FullBunRuntimePlugin {
  return {
    start: runtime.start.bind(runtime),
    getStatus: runtime.getStatus.bind(runtime),
    call: runtime.call.bind(runtime),
  };
}

export function isIosInProcessLocalAgentUrl(url: string): boolean {
  if (isNativeIosStoreBuild() && isLoopbackLocalAgentUrl(url)) return false;
  try {
    const parsed = new URL(url);
    if (isIosLocalAgentIpcUrl(parsed)) {
      return canUseIosLocalAgentIpc() || isCloudRuntimeAllowedIpcPath(parsed);
    }
    if (
      usesStrictIosNetworkPolicy() &&
      isCleartextNetworkUrl(parsed) &&
      isPrivateOrLoopbackHost(parsed.hostname)
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return isNativeIos() && isMobileLocalAgentUrl(url);
}

export function isIosInProcessLocalAgentBase(
  baseUrl: string | null | undefined,
): boolean {
  if (!baseUrl) return false;
  return isIosInProcessLocalAgentUrl(
    `${baseUrl.replace(/\/+$/, "")}/api/health`,
  );
}

function isSafeLocalPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(path)
  );
}

function requestPathFromUrl(url: string): string {
  const localAgentPath = mobileLocalAgentPathFromUrl(url);
  if (localAgentPath) return localAgentPath;
  const parsed = new URL(url, `${IOS_LOCAL_AGENT_IPC_BASE}/`);
  return `${parsed.pathname}${parsed.search}`;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function normalizeNativeResult(
  value: unknown,
): IosLocalAgentNativeRequestResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== "number" ||
    typeof record.statusText !== "string" ||
    typeof record.body !== "string" ||
    !record.headers ||
    typeof record.headers !== "object" ||
    Array.isArray(record.headers)
  ) {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record.headers)) {
    if (typeof raw === "string") headers[key] = raw;
  }
  return {
    status: record.status,
    statusText: record.statusText,
    headers,
    body: record.body,
    bodyBase64:
      typeof record.bodyBase64 === "string" ? record.bodyBase64 : undefined,
    bodyEncoding:
      typeof record.bodyEncoding === "string" ? record.bodyEncoding : undefined,
  };
}

function normalizeStartupTraceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStartupTraceId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const startupTrace = (
    window as Window & {
      [STARTUP_TRACE_WINDOW_KEY]?: { traceId?: unknown };
    }
  )[STARTUP_TRACE_WINDOW_KEY];
  return (
    normalizeStartupTraceId(window[STARTUP_TRACE_ID_WINDOW_KEY]) ??
    normalizeStartupTraceId(startupTrace?.traceId)
  );
}

function iosFullBunEnv(): Record<string, string> {
  const startupTraceId = readStartupTraceId();
  return startupTraceId
    ? { ...IOS_FULL_BUN_ENV, ELIZA_STARTUP_TRACE_ID: startupTraceId }
    : IOS_FULL_BUN_ENV;
}

let tracedEngineAcquire = false;

async function getFullBunRuntime(): Promise<FullBunRuntimePlugin | null> {
  const strict = shouldRequireFullBunRuntime();
  const pluginAvailable = isFullBunRuntimePluginAvailable();
  if (!tracedEngineAcquire && isNativeIos()) {
    tracedEngineAcquire = true;
    appendIosBootTrace("engine-acquire", {
      copy: "app-core",
      strict,
      builtIn: isFullBunRuntimeBuiltIn(),
      pluginAvailable,
      runtimeMode: readRuntimeMode(),
    });
  }
  if (!isNativeIos() && !strict) return null;
  if (!strict && !isFullBunRuntimeBuiltIn()) return null;
  if (!pluginAvailable) {
    if (strict) {
      throw fullBunStartupError("the ElizaBunRuntime plugin is unavailable");
    }
    return null;
  }
  if (isPrimedFullBunRuntime(fullBunRuntime)) {
    return fullBunRuntime.runtime;
  }
  fullBunRuntime ??= (async () => {
    try {
      // importFullBunRuntimePlugin resolves to a plain wrapped object (never
      // the raw Capacitor proxy — awaiting the proxy deadlocks; see the
      // comment inside it).
      const runtime = await importFullBunRuntimePlugin();
      const currentStatus = await runtime.getStatus().catch(() => null);
      if (currentStatus?.ready && currentStatus.engine === "bun") {
        recordIosNativeAgentBootPhase("ready");
        appendIosBootTrace("engine-adopted-running", {
          copy: "app-core",
          engine: currentStatus.engine,
        });
        return runtime;
      }
      recordIosNativeAgentBootPhase("starting");
      appendIosBootTrace("engine-start-requested", { copy: "app-core" });
      const startRequestedAt = Date.now();
      const started = await runtime.start({
        engine: "bun",
        argv: IOS_FULL_BUN_ARGV,
        env: iosFullBunEnv(),
      });
      if (!started.ok) {
        throw new Error(started.error ?? "runtime start returned ok=false");
      }
      const status = await runtime.getStatus();
      if (!status.ready || status.engine !== "bun") {
        throw new Error(
          `runtime status was ready=${String(status.ready)} engine=${
            status.engine ?? "unknown"
          }`,
        );
      }
      recordIosNativeAgentBootPhase("ready");
      appendIosBootTrace("engine-start-ok", {
        copy: "app-core",
        durationMs: Date.now() - startRequestedAt,
        engine: status.engine,
      });
      return runtime;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordIosNativeAgentBootPhase("error", message);
      if (strict) {
        throw fullBunStartupError("startup failed", error);
      }
      return null;
    }
  })();
  try {
    if (isPrimedFullBunRuntime(fullBunRuntime)) {
      return fullBunRuntime.runtime;
    }
    const runtime = await fullBunRuntime;
    if (!runtime) fullBunRuntime = null;
    return runtime;
  } catch (error) {
    fullBunRuntime = null;
    throw error;
  }
}

export function primeIosFullBunRuntime(runtime: unknown): void {
  const candidate = runtime as FullBunRuntimePlugin | null;
  fullBunRuntime = {
    kind: "primed",
    runtime: candidate ? wrapFullBunRuntime(candidate) : null,
  };
}

async function importFullBunRuntimePlugin(): Promise<FullBunRuntimePlugin> {
  appendIosBootTrace("engine-import-start", { copy: "app-core" });
  let mod: Partial<FullBunRuntimeModule> | null = null;
  try {
    mod = (await import(
      "@elizaos/capacitor-bun-runtime"
    )) as Partial<FullBunRuntimeModule>;
  } catch {
    mod = null;
  }
  appendIosBootTrace("engine-import-done", {
    copy: "app-core",
    viaModule: Boolean(mod?.ElizaBunRuntime),
  });
  // CRITICAL (#11030 device boot hang): never return the raw Capacitor plugin
  // proxy across an `await` boundary. registerPlugin's Proxy fabricates a
  // native-method wrapper for ANY property — including `then` — so promise
  // resolution treats the proxy as a thenable whose `then(resolve, reject)`
  // is a Capacitor method wrapper that NEVER invokes its callbacks. Every
  // caller of this async function then awaits forever, the engine never
  // starts, and the phone dead-ends on the startup-timeout card. Wrapping
  // into a plain bound-method object BEFORE returning makes the resolved
  // value thenable-free and safe to await.
  return wrapFullBunRuntime(
    mod?.ElizaBunRuntime ??
      registerPlugin<FullBunRuntimePlugin>("ElizaBunRuntime"),
  );
}

async function restartIosFullBunRuntimeFromWatchdog(): Promise<void> {
  if (restartRequestInFlight) return restartRequestInFlight;
  restartRequestInFlight = (async () => {
    if (!isNativeIos()) return;
    if (isPureRemoteRuntimeMode(readRuntimeMode())) return;
    appendIosBootTrace("watchdog-restart-handling", {
      pluginAvailable: isFullBunRuntimePluginAvailable(),
    });
    if (!isFullBunRuntimePluginAvailable()) {
      throw fullBunStartupError("the ElizaBunRuntime plugin is unavailable");
    }

    const runtime = isPrimedFullBunRuntime(fullBunRuntime)
      ? fullBunRuntime.runtime
      : await importFullBunRuntimePlugin();
    if (!runtime) {
      throw fullBunStartupError("the ElizaBunRuntime plugin is unavailable");
    }

    recordIosNativeAgentBootPhase("starting");
    appendIosBootTrace("engine-start-requested", {
      copy: "app-core",
      source: "watchdog-restart",
    });
    const started = await runtime.start({
      engine: "bun",
      argv: IOS_FULL_BUN_ARGV,
      env: iosFullBunEnv(),
    });
    if (!started.ok) {
      throw new Error(started.error ?? "runtime start returned ok=false");
    }
    const status = await runtime.getStatus();
    if (!status.ready || status.engine !== "bun") {
      throw new Error(
        `runtime status was ready=${String(status.ready)} engine=${
          status.engine ?? "unknown"
        }`,
      );
    }
    recordIosNativeAgentBootPhase("ready");
    appendIosBootTrace("engine-start-ok", {
      copy: "app-core",
      source: "watchdog-restart",
      engine: status.engine,
    });
    fullBunRuntime = { kind: "primed", runtime };
  })().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    recordIosNativeAgentBootPhase("error", message);
    appendIosBootTrace("watchdog-restart-failed", {
      message: message.slice(0, 300),
    });
    throw error;
  });
  restartRequestInFlight = restartRequestInFlight.finally(() => {
    restartRequestInFlight = null;
  });
  return restartRequestInFlight;
}

function installIosLocalAgentRestartRequestListener(): void {
  if (restartRequestListenerInstalled) return;
  if (typeof window === "undefined") return;
  if (typeof window.addEventListener !== "function") return;
  if (window[IOS_RESTART_LISTENER_WINDOW_KEY]) return;
  window.addEventListener(
    "eliza:local-agent-restart-requested",
    (event: Event) => {
      const detail = (event as CustomEvent<IosLocalAgentRestartRequestDetail>)
        .detail;
      void restartIosFullBunRuntimeFromWatchdog().catch((error) => {
        console.error("[ios-local-agent] Watchdog restart request failed", {
          attempt: detail?.attempt,
          source: detail?.source,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  );
  window[IOS_RESTART_LISTENER_WINDOW_KEY] = true;
  restartRequestListenerInstalled = true;
}

async function tryFullBunNativeRequest(
  options: IosLocalAgentNativeRequestOptions,
): Promise<IosLocalAgentNativeRequestResult | null> {
  const runtime = await getFullBunRuntime();
  if (!runtime) return null;
  const response = await runtime.call({
    method: "http_request",
    args: {
      method: options.method,
      path: options.path,
      headers: options.headers,
      body: options.body,
      timeoutMs: options.timeoutMs,
    },
  });
  const result = normalizeNativeResult(response.result);
  if (!result) {
    throw new Error("Full Bun iOS bridge returned an invalid HTTP response");
  }
  // Any structured response over the bridge — including a 503 from a mid-boot
  // agent kernel — proves the in-process runtime is alive. The startup poll
  // uses this heartbeat to keep boot-time 503s from burning its
  // consecutive-failure budget.
  recordIosNativeAgentBootHeartbeat();
  return result;
}

async function requestToNativeBridgeOptions(
  request: Request,
  context?: { timeoutMs?: number },
): Promise<IosLocalAgentNativeRequestOptions> {
  const method = request.method.trim().toUpperCase();
  return {
    method,
    path: requestPathFromUrl(request.url),
    headers: headersToRecord(request.headers),
    body: method === "GET" || method === "HEAD" ? null : await request.text(),
    timeoutMs: context?.timeoutMs,
  };
}

/**
 * Reconstruct the response body. Prefer the lossless `bodyBase64` (raw bytes)
 * so binary payloads — served media, generated images, TTS audio — survive the
 * bridge; fall back to the UTF-8 `body` string when base64 is absent.
 */
function nativeResponseBody(
  result: IosLocalAgentNativeRequestResult,
): ArrayBuffer | string {
  const base64 = result.bodyBase64;
  if (typeof base64 === "string" && base64.length > 0) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  return result.body;
}

function nativeResultToResponse(
  result: IosLocalAgentNativeRequestResult,
): Response {
  const body =
    result.status === 204 || result.status === 205 || result.status === 304
      ? null
      : nativeResponseBody(result);
  return new Response(body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

async function dispatchIosLocalAgentRequest(
  request: Request,
  context?: { timeoutMs?: number },
): Promise<Response> {
  const options = await requestToNativeBridgeOptions(request, context);
  return nativeResultToResponse(
    await handleIosLocalAgentNativeRequest(options),
  );
}

let tracedNativeRequests = 0;

export async function handleIosLocalAgentNativeRequest(
  options: IosLocalAgentNativeRequestOptions,
): Promise<IosLocalAgentNativeRequestResult> {
  if (tracedNativeRequests < 3) {
    tracedNativeRequests += 1;
    appendIosBootTrace("native-request", {
      copy: "app-core",
      n: tracedNativeRequests,
      path: options.path?.slice(0, 120) ?? null,
    });
  }
  const path = options.path?.trim();
  if (!path || !isSafeLocalPath(path)) {
    throw new Error(
      "iOS local Agent.request requires a path that starts with / and is not an absolute URL",
    );
  }
  const method = (options.method ?? "GET").trim().toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) {
    throw new Error("Unsupported HTTP method");
  }
  if (
    isNativeIosCloudRuntime() &&
    !iosRuntimeHasOnDeviceAgent() &&
    !isCloudRuntimeAllowedLocalAgentPath(path)
  ) {
    throw new TypeError(
      "iOS cloud builds cannot use local-agent IPC unless local runtime mode is active",
    );
  }

  const fullBunResult = await tryFullBunNativeRequest({
    ...options,
    method,
    path,
  });
  if (fullBunResult) return fullBunResult;

  if (isNativeIosStoreBuild()) {
    throw fullBunStartupError(
      "the foreground ITTP compatibility transport is disabled for iOS store builds",
    );
  }
  if (!canUseJsContextCompatibilityFallback()) {
    throw fullBunStartupError(
      "the JSContext compatibility transport is disabled outside iOS development builds",
    );
  }

  startIosLocalAgentKernel();
  const response = await handleIosLocalAgentRequest(
    new Request(`${IOS_LOCAL_AGENT_IPC_BASE}${path}`, {
      method,
      headers: options.headers,
      body:
        options.body == null || method === "GET" || method === "HEAD"
          ? undefined
          : options.body,
    }),
    { timeoutMs: options.timeoutMs },
  );
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await response.text(),
  };
}

export function installIosLocalAgentNativeRequestBridge(): void {
  if (typeof window === "undefined") return;
  if (!globalRequestHandlerInstalled) {
    registerElizaBridgeCapability(
      "iosLocalAgentRequest",
      handleIosLocalAgentNativeRequest,
    );
    installElizaBridge();
    globalRequestHandlerInstalled = true;
  }
  installIosLocalAgentRestartRequestListener();
}

function shouldBridgeFetchUrl(url: URL): boolean {
  if (!isNativeIos()) return false;
  if (isNativeIosStoreBuild() && isLoopbackLocalAgentUrl(url.toString())) {
    throw new TypeError(
      "iOS store builds must use eliza-local-agent://ipc for local-agent requests",
    );
  }
  if (isIosLocalAgentIpcUrl(url) && !canUseIosLocalAgentIpc()) {
    if (isCloudRuntimeAllowedIpcPath(url)) return true;
    throw new TypeError(
      "iOS cloud builds cannot use local-agent IPC unless local runtime mode is active",
    );
  }
  if (
    usesStrictIosNetworkPolicy() &&
    isCleartextNetworkUrl(url) &&
    (isNativeIosStoreBuild() || isPrivateOrLoopbackHost(url.hostname))
  ) {
    throw new TypeError(
      "iOS store/cloud builds block cleartext loopback or private-network requests",
    );
  }
  if (isMobileLocalAgentUrl(url.toString())) return true;
  if (isNativeIosCloudRuntime()) return false;
  if ((url.pathname || "").startsWith("/api/")) {
    return (
      shouldRequireFullBunRuntime() ||
      readPersistedRuntimeMode() === "local" ||
      isIosInProcessLocalAgentBase(getElizaApiBase())
    );
  }
  return false;
}

function localAgentUrlForFetch(url: URL): string {
  const localAgentPath = mobileLocalAgentPathFromUrl(url.toString());
  if (localAgentPath) return `${IOS_LOCAL_AGENT_IPC_BASE}${localAgentPath}`;
  return `${IOS_LOCAL_AGENT_IPC_BASE}${url.pathname || "/"}${url.search}`;
}

export function installIosLocalAgentFetchBridge(): void {
  installIosLocalAgentRestartRequestListener();
  if (globalFetchBridgeInstalled) return;
  if (typeof globalThis.fetch !== "function") return;
  const nativeFetch = globalThis.fetch;
  originalFetch = nativeFetch.bind(globalThis);
  const bridgedFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const original = originalFetch;
    if (!original) return fetch(input, init);

    const request = input instanceof Request ? input.clone() : null;
    const rawUrl = request?.url ?? String(input);
    let url: URL;
    try {
      url = new URL(
        rawUrl,
        typeof window !== "undefined"
          ? (window.location?.href ?? "http://localhost")
          : "http://localhost",
      );
    } catch {
      return original(input, init);
    }

    if (!shouldBridgeFetchUrl(url)) return original(input, init);

    const bridgedUrl = localAgentUrlForFetch(url);
    const bridgedRequest = request
      ? new Request(bridgedUrl, request)
      : new Request(bridgedUrl, init);
    return dispatchIosLocalAgentRequest(bridgedRequest);
  }) as typeof fetch;
  const nativeFetchWithPreconnect = nativeFetch as FetchWithOptionalPreconnect;
  if (typeof nativeFetchWithPreconnect.preconnect === "function") {
    (bridgedFetch as FetchWithOptionalPreconnect).preconnect =
      nativeFetchWithPreconnect.preconnect.bind(nativeFetch);
  }
  globalThis.fetch = bridgedFetch;
  globalFetchBridgeInstalled = true;
}

export async function iosInProcessAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  if (!isIosInProcessLocalAgentUrl(url)) return null;
  installIosLocalAgentNativeRequestBridge();
  installIosLocalAgentFetchBridge();
  transport ??= createIttpAgentTransport((request, context) =>
    dispatchIosLocalAgentRequest(request, context),
  );
  return transport;
}
