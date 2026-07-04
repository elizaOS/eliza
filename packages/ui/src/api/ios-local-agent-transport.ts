import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  installElizaBridge,
  registerElizaBridgeCapability,
} from "../bridge/eliza-window-bridge";
import { isStoreBuild } from "../build-variant";
import { getBootConfig } from "../config/boot-config";
import {
  isMobileLocalAgentUrl as isConfiguredMobileLocalAgentUrl,
  isMobileLocalAgentIpcUrl,
  mobileLocalAgentPathFromUrl,
} from "../first-run/mobile-runtime-mode";
import {
  handleIosLocalAgentRequest,
  startIosLocalAgentKernel,
} from "./ios-local-agent-kernel";
import { createIosStreamingAgentPlugin } from "./ios-streaming-agent-plugin";
import { createIttpAgentTransport } from "./ittp-agent-transport";
import { createNativeStreamingResponse } from "./native-agent-stream";
import {
  type AgentRequestTransport,
  headersToRecord,
  isStreamingRequest,
} from "./transport";

let transport: AgentRequestTransport | null = null;
let globalRequestHandlerInstalled = false;
let globalFetchBridgeInstalled = false;
let originalFetch: typeof fetch | null = null;
let fullBunRuntime:
  | Promise<FullBunRuntimePlugin | null>
  | PrimedFullBunRuntime
  | null = null;
const IOS_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";

/**
 * Policy error raised when a cloud-mode iOS build tries to reach the on-device
 * agent over local-agent IPC. Non-retryable within a session: it depends only
 * on the build's runtime mode and the persisted `eliza:mobile-runtime-mode`,
 * neither of which changes while the startup poll runs (issue #11030).
 */
const IOS_CLOUD_MODE_LOCAL_IPC_POLICY_MESSAGE =
  "iOS cloud builds cannot use local-agent IPC unless local runtime mode is active";

/**
 * Message fragments of TERMINAL (non-retryable) native agent/transport boot
 * failures. Each is a build-config or runtime-mode policy violation that
 * cannot self-heal while the renderer keeps polling — retrying only produces
 * the same rejection until the backend-poll deadline, which is how the iOS
 * device boot hang in issue #11030 presented ("Booting up…" forever).
 */
const TERMINAL_IOS_NATIVE_AGENT_BOOT_ERROR_FRAGMENTS: readonly string[] = [
  IOS_CLOUD_MODE_LOCAL_IPC_POLICY_MESSAGE,
  "iOS store builds must use eliza-local-agent://ipc for local-agent requests",
  "iOS store/cloud builds block cleartext loopback or private-network requests",
  // fullBunStartupError(): the build REQUIRES the embedded Bun engine and it
  // is missing or failed to start — no amount of polling revives it.
  "Full Bun iOS runtime required but",
  // plugins/plugin-native-agent AgentPlugin.swift missingEndpointMessage():
  // remote/cloud mode with no configured Agent.apiBase. Surfaces through
  // native Agent plugin call rejections and getStatus state:"error".
  "iOS Agent requires a configured HTTP endpoint",
];

/**
 * True when a startup-time request failure is a terminal native transport /
 * agent-config error that will never succeed on retry. Consumed by
 * `state/startup-phase-poll.ts` to fail fast into the coordinator's error
 * phase (surfacing the real message + Retry) instead of blind-polling to the
 * backend deadline.
 */
export function isTerminalIosNativeAgentBootErrorMessage(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  return TERMINAL_IOS_NATIVE_AGENT_BOOT_ERROR_FRAGMENTS.some((fragment) =>
    message.includes(fragment),
  );
}

type FetchWithOptionalPreconnect = typeof fetch & {
  preconnect?: (...args: unknown[]) => unknown;
};

// ---------------------------------------------------------------------------
// iOS boot trace (renderer side) — persisted startup observability
// ---------------------------------------------------------------------------
//
// The native shell appends its stage events to Documents/eliza-boot-trace.jsonl
// (packages/app-core/platforms/ios/App/App/ElizaStartupTrace.swift). The
// renderer appends to the SAME file through the native Agent plugin's
// `appendBootTrace` bridge method (the Filesystem pod is not shipped in the
// iOS app), so a single serialized native writer owns the file and lines
// never interleave. Retrieval WITHOUT an attached console:
//
//   xcrun devicectl device copy from --device <id> \
//     --domain-type appDataContainer --domain-identifier ai.elizaos.app \
//     --source Documents/eliza-boot-trace.jsonl --destination <out>

const IOS_BOOT_TRACE_MAX_ENTRIES_PER_SESSION = 400;

interface AgentBootTracePluginLike {
  appendBootTrace(options: {
    stage: string;
    detail: Record<string, unknown>;
  }): Promise<unknown>;
}

let agentPluginForBootTrace: AgentBootTracePluginLike | null | undefined;
let bootTraceDisabled = false;
let bootTraceConsecutiveFailures = 0;
let bootTraceEntryCount = 0;
const bootTraceLaunchedAtMs = Date.now();
/** Bridge rejections tolerated before the trace sink turns itself off. A
 * single transient rejection must NOT silence startup telemetry forever —
 * that blindness is exactly what made the #11030 device hang unreadable. */
const BOOT_TRACE_MAX_CONSECUTIVE_BRIDGE_FAILURES = 3;

function resolveBootTraceBridge(): AgentBootTracePluginLike | null {
  if (agentPluginForBootTrace !== undefined) {
    return agentPluginForBootTrace;
  }
  try {
    const capacitor = Capacitor as typeof Capacitor & {
      isPluginAvailable?: (name: string) => boolean;
    };
    if (!isNativeIos() || capacitor.isPluginAvailable?.("Agent") !== true) {
      agentPluginForBootTrace = null;
      return null;
    }
    agentPluginForBootTrace = registerPlugin<AgentBootTracePluginLike>("Agent");
  } catch {
    agentPluginForBootTrace = null;
  }
  return agentPluginForBootTrace;
}

/**
 * Append one structured entry to the on-device iOS boot trace
 * (Documents/eliza-boot-trace.jsonl, written natively by ElizaStartupTrace).
 * No-op off native iOS, after a bridge failure (telemetry must never break
 * startup), and past the per-session entry cap (bounded growth; the native
 * writer additionally rotates the file at ~1 MB). Detail values must never
 * include tokens or credentials.
 */
export function appendIosBootTrace(
  stage: string,
  detail: Record<string, unknown> = {},
): void {
  const bridge = resolveBootTraceBridge();
  if (!bridge || bootTraceDisabled) return;
  if (bootTraceEntryCount >= IOS_BOOT_TRACE_MAX_ENTRIES_PER_SESSION) return;
  bootTraceEntryCount += 1;
  let safeDetail: Record<string, unknown>;
  try {
    // Round-trip through JSON so only serializable values cross the bridge.
    safeDetail = JSON.parse(
      JSON.stringify({
        sinceLaunchMs: Date.now() - bootTraceLaunchedAtMs,
        ...detail,
      }),
    ) as Record<string, unknown>;
  } catch {
    return;
  }
  bridge
    .appendBootTrace({ stage, detail: safeDetail })
    .then(() => {
      bootTraceConsecutiveFailures = 0;
    })
    .catch((error: unknown) => {
      // Older native shells without the method reject with "not implemented";
      // disable immediately for those. Otherwise tolerate a bounded number of
      // transient bridge failures before going quiet.
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      bootTraceConsecutiveFailures += 1;
      if (
        /not implemented|is not available|method not found/i.test(message) ||
        bootTraceConsecutiveFailures >=
          BOOT_TRACE_MAX_CONSECUTIVE_BRIDGE_FAILURES
      ) {
        bootTraceDisabled = true;
      }
    });
}

// ---------------------------------------------------------------------------
// iOS native agent boot progress — heartbeat state for the startup poll
// ---------------------------------------------------------------------------
//
// While the in-process Bun engine boots (CPU-bound, no JIT on iOS), startup
// probes either queue behind the start promise or receive structured 503s
// from the not-yet-ready agent kernel. Neither is a TRANSPORT failure — the
// bridge is alive and the agent is making progress. This state lets
// state/startup-phase-poll.ts keep its consecutive-failure budget from
// burning while boot progress is provable, without touching the overall
// backend deadline. Only a terminal engine error or heartbeat silence lets
// the budget resume.

export type IosNativeAgentBootPhase = "idle" | "starting" | "ready" | "error";

export interface IosNativeAgentBootProgress {
  phase: IosNativeAgentBootPhase;
  startedAt: number | null;
  lastHeartbeatAt: number | null;
  lastError: string | null;
}

/**
 * Silence budget while the engine start promise is pending. The engine start
 * itself is bounded natively by ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS (300s in
 * IOS_FULL_BUN_ENV) — mirror it so a genuinely hung start eventually lets the
 * failure budget burn.
 */
const IOS_ENGINE_START_SILENCE_BUDGET_MS = 300_000;

/** Freshness window for post-start heartbeats (structured bridge responses). */
const IOS_BOOT_HEARTBEAT_SILENCE_MS = 30_000;

let iosAgentBootProgress: IosNativeAgentBootProgress = {
  phase: "idle",
  startedAt: null,
  lastHeartbeatAt: null,
  lastError: null,
};

/** Record a native-agent boot phase transition (also traced + heartbeat). */
export function recordIosNativeAgentBootPhase(
  phase: IosNativeAgentBootPhase,
  error?: string | null,
): void {
  const now = Date.now();
  iosAgentBootProgress = {
    phase,
    startedAt:
      phase === "starting" ? now : (iosAgentBootProgress.startedAt ?? now),
    lastHeartbeatAt: now,
    lastError:
      error ?? (phase === "error" ? iosAgentBootProgress.lastError : null),
  };
  appendIosBootTrace("agent-boot-phase", {
    phase,
    ...(error ? { error } : {}),
  });
}

/** Record liveness proof: a structured response crossed the native bridge. */
export function recordIosNativeAgentBootHeartbeat(): void {
  iosAgentBootProgress = {
    ...iosAgentBootProgress,
    lastHeartbeatAt: Date.now(),
  };
}

export function getIosNativeAgentBootProgress(): IosNativeAgentBootProgress {
  return { ...iosAgentBootProgress };
}

/**
 * True while the on-device agent is provably booting or alive: the engine
 * start is pending within its own timeout, or the engine reported ready and
 * the bridge produced a structured response recently. False on terminal
 * error and on heartbeat silence — exactly the two conditions that should
 * let the startup poll's consecutive-failure budget burn.
 */
export function isIosNativeAgentBootInProgress(now = Date.now()): boolean {
  const progress = iosAgentBootProgress;
  if (progress.phase === "starting") {
    return (
      progress.startedAt !== null &&
      now - progress.startedAt < IOS_ENGINE_START_SILENCE_BUDGET_MS
    );
  }
  if (progress.phase === "ready") {
    return (
      progress.lastHeartbeatAt !== null &&
      now - progress.lastHeartbeatAt < IOS_BOOT_HEARTBEAT_SILENCE_MS
    );
  }
  return false;
}

/** Test-only reset of the module-level boot-progress state. */
export function resetIosNativeAgentBootProgressForTests(): void {
  iosAgentBootProgress = {
    phase: "idle",
    startedAt: null,
    lastHeartbeatAt: null,
    lastError: null,
  };
}

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
   * payloads (served media, generated images, TTS audio) survive the bridge —
   * `body` is a best-effort UTF-8 view that mangles non-text bytes. The native
   * bridge always supplies this; mirrors the Android transport.
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
  // Native → WebView chat-stream events (`agentStream*`), emitted by the engine's
  // `stream_emit` host-call while `http_request_stream` runs (#12354). Optional
  // here because older engine builds predate it; the streaming path checks for
  // it and falls back to buffered when absent.
  addListener?: (
    eventName: string,
    listener: (event: unknown) => void,
  ) => Promise<{ remove: () => void | Promise<void> }>;
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

type ImportMetaEnvRecord = Record<string, string | boolean | undefined>;

declare global {
  interface Window {
    __ELIZA_IOS_LOCAL_AGENT_REQUEST__?: (
      options: IosLocalAgentNativeRequestOptions,
    ) => Promise<IosLocalAgentNativeRequestResult>;
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

function getElizaApiBase(): string | undefined {
  return getBootConfig().apiBase?.trim() || undefined;
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

function usesStrictIosNetworkPolicy(): boolean {
  return isNativeIosStoreBuild() || isNativeIosCloudRuntime();
}

function isLoopbackLocalAgentUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname || "";
    return (
      parsed.protocol === "http:" &&
      parsed.port === "31337" &&
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

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function allowsIosSimulatorLoopback(url: URL): boolean {
  return (
    !isNativeIosStoreBuild() &&
    isTruthyBuildFlag(viteEnv().VITE_ELIZA_IOS_ALLOW_SIMULATOR_LOOPBACK) &&
    isLoopbackHost(url.hostname)
  );
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
 * Whether the selected runtime runs an on-device agent that serves local-agent
 * IPC. `local`, `cloud-hybrid`, and `tunnel-to-mobile` all run the bundled
 * phone-side agent; only pure `cloud` talks exclusively to a remote agent.
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
    addListener: runtime.addListener?.bind(runtime),
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
      isPrivateOrLoopbackHost(parsed.hostname) &&
      !allowsIosSimulatorLoopback(parsed)
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

let tracedEngineAcquire = false;

async function getFullBunRuntime(): Promise<FullBunRuntimePlugin | null> {
  const strict = shouldRequireFullBunRuntime();
  const pluginAvailable = isFullBunRuntimePluginAvailable();
  if (!tracedEngineAcquire && isNativeIos()) {
    tracedEngineAcquire = true;
    appendIosBootTrace("engine-acquire", {
      copy: "ui",
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
      // The native ElizaBunRuntime plugin is registered (isFullBunRuntimePlugin-
      // Available passed above). The JS wrapper `@elizaos/capacitor-bun-runtime`
      // is externalized in the native web bundle, so the dynamic import has two
      // non-fatal failure shapes: it can RESOLVE to a module without the
      // ElizaBunRuntime export, OR it can THROW "Module name … does not resolve
      // to a valid URL" (a bare specifier the WKWebView can't load). Either way
      // the native plugin is reachable via registerPlugin — so recover instead of
      // letting the import error escape to the strict handler and fail iOS local
      // startup with "Backend Timeout" (the reported first-run hang). A genuine
      // failure still surfaces below: runtime.start() throwing is NOT caught here.
      // importFullBunRuntimePlugin resolves to a plain wrapped object (never
      // the raw Capacitor proxy — awaiting the proxy deadlocks; see the
      // comment inside it).
      const runtime = await importFullBunRuntimePlugin();
      const currentStatus = await runtime.getStatus().catch(() => null);
      if (currentStatus?.ready && currentStatus.engine === "bun") {
        recordIosNativeAgentBootPhase("ready");
        appendIosBootTrace("engine-adopted-running", {
          engine: currentStatus.engine,
        });
        return runtime;
      }
      recordIosNativeAgentBootPhase("starting");
      appendIosBootTrace("engine-start-requested", { copy: "ui" });
      const startRequestedAt = Date.now();
      const started = await runtime.start({
        engine: "bun",
        argv: IOS_FULL_BUN_ARGV,
        env: IOS_FULL_BUN_ENV,
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
  appendIosBootTrace("engine-import-start", { copy: "ui" });
  let mod: Partial<FullBunRuntimeModule> | null = null;
  try {
    mod = (await import(
      "@elizaos/capacitor-bun-runtime"
    )) as Partial<FullBunRuntimeModule>;
  } catch {
    mod = null;
  }
  appendIosBootTrace("engine-import-done", {
    copy: "ui",
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
  // Any structured response over the bridge — including a 503 from a
  // mid-boot agent kernel — proves the in-process runtime is alive. The
  // startup poll uses this heartbeat to keep boot-time 503s from burning
  // its consecutive-failure budget.
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

/**
 * Try to serve the request as an incremental token stream over the full-Bun
 * runtime's `http_request_stream` bridge (#12354). Returns `null` when the
 * request is not an SSE stream, the runtime is unavailable, or the stream head
 * never arrives — the caller then falls back to the buffered path (which fakes a
 * single-frame SSE), so a streaming failure never drops the chat reply.
 */
async function tryFullBunStreamingResponse(
  options: IosLocalAgentNativeRequestOptions,
): Promise<Response | null> {
  const runtime = await getFullBunRuntime();
  if (!runtime?.addListener) return null;
  const plugin = createIosStreamingAgentPlugin(
    { call: runtime.call, addListener: runtime.addListener },
    (error) => {
      console.warn("[ios-local-agent] stream request failed after head", {
        path: options.path?.slice(0, 120) ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  const response = await createNativeStreamingResponse(plugin, {
    method: options.method,
    path: options.path,
    headers: options.headers,
    body: options.body ?? null,
    timeoutMs: options.timeoutMs,
  });
  recordIosNativeAgentBootHeartbeat();
  return response;
}

async function dispatchIosLocalAgentRequest(
  request: Request,
  context?: { timeoutMs?: number },
): Promise<Response> {
  const options = await requestToNativeBridgeOptions(request, context);

  // Route the chat token stream (POST …/messages/stream, or any
  // Accept: text/event-stream request) through the streaming bridge so tokens
  // render incrementally instead of the buffered single-frame fallback.
  if (isStreamingRequest(request.url, request.headers)) {
    try {
      const streamed = await tryFullBunStreamingResponse(options);
      if (streamed) return streamed;
    } catch {
      // Stream couldn't start — fall through to the buffered request path.
    }
  }

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
      copy: "ui",
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
    throw new TypeError(IOS_CLOUD_MODE_LOCAL_IPC_POLICY_MESSAGE);
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
  if (globalRequestHandlerInstalled) return;
  if (typeof window === "undefined") return;
  registerElizaBridgeCapability(
    "iosLocalAgentRequest",
    handleIosLocalAgentNativeRequest,
  );
  installElizaBridge();
  globalRequestHandlerInstalled = true;
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
    throw new TypeError(IOS_CLOUD_MODE_LOCAL_IPC_POLICY_MESSAGE);
  }
  if (
    usesStrictIosNetworkPolicy() &&
    isCleartextNetworkUrl(url) &&
    (isNativeIosStoreBuild() || isPrivateOrLoopbackHost(url.hostname)) &&
    !allowsIosSimulatorLoopback(url)
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
