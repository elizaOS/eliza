import { Capacitor } from "@capacitor/core";
import { isMobileLocalAgentUrl } from "../onboarding/local-agent-token";
import { getElizaApiBase } from "../utils/eliza-globals";
import {
  handleIosLocalAgentRequest,
  startIosLocalAgentKernel,
} from "./ios-local-agent-kernel";
import { createIttpAgentTransport } from "./ittp-agent-transport";
import type { AgentRequestTransport } from "./transport";

let transport: AgentRequestTransport | null = null;
let globalRequestHandlerInstalled = false;
let globalFetchBridgeInstalled = false;
let originalFetch: typeof fetch | null = null;
let fullBunRuntime: Promise<{ runtime: FullBunRuntimePlugin | null }> | null =
  null;

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
}

export interface FullBunRuntimePlugin {
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

interface FullBunRuntimeModule {
  ElizaBunRuntime: FullBunRuntimePlugin;
}

const FULL_BUN_RUNTIME_CALL_TIMEOUT_MS = 120_000;
const IOS_FULL_BUN_SMOKE_REQUEST_KEY = "eliza:ios-full-bun-smoke:request";

type ImportMetaEnvRecord = Record<string, string | boolean | undefined>;

declare global {
  interface Window {
    __ELIZA_IOS_LOCAL_AGENT_REQUEST__?: (
      options: IosLocalAgentNativeRequestOptions,
    ) => Promise<IosLocalAgentNativeRequestResult>;
    __ELIZA_IOS_LOCAL_AGENT_DEBUG__?: (
      event: Record<string, unknown>,
    ) => void;
  }
}

function viteEnv(): ImportMetaEnvRecord {
  return (import.meta as ImportMeta & { env?: ImportMetaEnvRecord }).env ?? {};
}

function isTruthyBuildFlag(value: string | boolean | undefined): boolean {
  return value === true || /^(1|true|yes|on)$/i.test(String(value ?? ""));
}

function isLocalStorageFlagEnabled(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function shouldRequireFullBunRuntime(): boolean {
  const env = viteEnv();
  const iosRuntimeMode =
    env.VITE_ELIZA_IOS_RUNTIME_MODE ?? env.VITE_MILADY_IOS_RUNTIME_MODE;
  return (
    isTruthyBuildFlag(env.VITE_ELIZA_IOS_FULL_BUN_STRICT) ||
    isTruthyBuildFlag(env.VITE_ELIZA_IOS_FULL_BUN_SMOKE) ||
    isTruthyBuildFlag(env.VITE_MILADY_IOS_FULL_BUN_STRICT) ||
    isTruthyBuildFlag(env.VITE_MILADY_IOS_FULL_BUN_SMOKE) ||
    isLocalStorageFlagEnabled(IOS_FULL_BUN_SMOKE_REQUEST_KEY) ||
    (isTruthyBuildFlag(env.PROD) && iosRuntimeMode === "local")
  );
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

function withTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: Promise<T>,
): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      globalThis.setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

function emitIosLocalAgentDebug(event: Record<string, unknown>): void {
  try {
    window.__ELIZA_IOS_LOCAL_AGENT_DEBUG__?.({
      ...event,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    // Debug hooks must never affect request handling.
  }
}

function isNativeIos(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
  } catch {
    return false;
  }
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

export function isIosInProcessLocalAgentUrl(url: string): boolean {
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
  const parsed = new URL(url, "http://127.0.0.1:31337");
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
  };
}

async function getFullBunRuntime(): Promise<{
  runtime: FullBunRuntimePlugin | null;
}> {
  const strict = shouldRequireFullBunRuntime();
  emitIosLocalAgentDebug({
    step: "transport-runtime-resolve-start",
    strict,
    nativeIos: isNativeIos(),
    hasCachedRuntime: Boolean(fullBunRuntime),
  });
  if (!isNativeIos() && !strict) return { runtime: null };
  fullBunRuntime ??= (async () => {
    try {
      const pluginReportedAvailable = isFullBunRuntimePluginAvailable();
      emitIosLocalAgentDebug({
        step: "transport-runtime-import-start",
        pluginReportedAvailable,
      });
      const mod = (await import(
        "@elizaos/capacitor-bun-runtime"
      )) as FullBunRuntimeModule;
      const runtime = mod.ElizaBunRuntime;
      emitIosLocalAgentDebug({
        step: "transport-runtime-imported",
        pluginReportedAvailable,
        hasRuntime: Boolean(runtime),
      });
      if (!runtime) {
        if (strict || pluginReportedAvailable) {
          throw new Error("ElizaBunRuntime plugin is unavailable");
        }
        return { runtime: null };
      }
      const existingStatus = await withTimeout(
        "ElizaBunRuntime.getStatus",
        10_000,
        runtime.getStatus(),
      );
      emitIosLocalAgentDebug({
        step: "transport-runtime-existing-status",
        ready: existingStatus.ready,
        engine: existingStatus.engine,
      });
      if (existingStatus.ready && existingStatus.engine === "bun") {
        return { runtime };
      }
      const started = await withTimeout(
        "ElizaBunRuntime.start",
        300_000,
        runtime.start({
          engine: "bun",
          argv: [
            "bun",
            "--no-install",
            "public/agent/agent-bundle.js",
            "ios-bridge",
            "--stdio",
          ],
          env: {
            ELIZA_PLATFORM: "ios",
            ELIZA_MOBILE_PLATFORM: "ios",
            ELIZA_IOS_LOCAL_BACKEND: "1",
            ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS: "300000",
            ELIZA_PGLITE_DISABLE_EXTENSIONS: "0",
            ELIZA_VAULT_BACKEND: "file",
            ELIZA_DISABLE_VAULT_PROFILE_RESOLVER: "1",
            ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP: "1",
            ELIZA_HEADLESS: "1",
            ELIZA_API_BIND: "127.0.0.1",
            LOG_LEVEL: "error",
          },
        }),
      );
      if (!started.ok) {
        throw new Error(started.error ?? "runtime start returned ok=false");
      }
      const status = await withTimeout(
        "ElizaBunRuntime.getStatus",
        10_000,
        runtime.getStatus(),
      );
      emitIosLocalAgentDebug({
        step: "transport-runtime-started-status",
        ready: status.ready,
        engine: status.engine,
      });
      if (!status.ready || status.engine !== "bun") {
        throw new Error(
          `runtime status was ready=${String(status.ready)} engine=${
            status.engine ?? "unknown"
          }`,
        );
      }
      return { runtime };
    } catch (error) {
      if (strict) {
        throw fullBunStartupError("startup failed", error);
      }
      return { runtime: null };
    }
  })();
  try {
    const holder = await fullBunRuntime;
    emitIosLocalAgentDebug({
      step: "transport-runtime-resolved",
      hasRuntime: Boolean(holder.runtime),
    });
    if (!holder.runtime) fullBunRuntime = null;
    return holder;
  } catch (error) {
    fullBunRuntime = null;
    throw error;
  }
}

export function primeIosFullBunRuntime(
  runtime: FullBunRuntimePlugin | null,
): void {
  emitIosLocalAgentDebug({
    step: "transport-runtime-primed",
    hasRuntime: Boolean(runtime),
  });
  fullBunRuntime = Promise.resolve({ runtime });
}

async function tryFullBunNativeRequest(
  options: IosLocalAgentNativeRequestOptions,
): Promise<IosLocalAgentNativeRequestResult | null> {
  emitIosLocalAgentDebug({
    step: "transport-request-start",
    method: options.method,
    path: options.path,
    hasBody: options.body != null,
  });
  const { runtime } = await getFullBunRuntime();
  emitIosLocalAgentDebug({
    step: "transport-runtime-ready",
    method: options.method,
    path: options.path,
    hasRuntime: Boolean(runtime),
  });
  if (!runtime) return null;
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, options.timeoutMs)
      : FULL_BUN_RUNTIME_CALL_TIMEOUT_MS;
  const args: Record<string, unknown> = {
    method: options.method,
    path: options.path,
    headers: options.headers,
    timeoutMs,
  };
  if (options.body != null) {
    args.body = options.body;
  }
  emitIosLocalAgentDebug({
    step: "transport-call-start",
    method: options.method,
    path: options.path,
    argKeys: Object.keys(args),
  });
  const response = await withTimeout(
    `ElizaBunRuntime.call(http_request ${options.path})`,
    timeoutMs,
    runtime.call({
      method: "http_request",
      args,
    }),
  );
  emitIosLocalAgentDebug({
    step: "transport-call-returned",
    method: options.method,
    path: options.path,
  });
  const result = normalizeNativeResult(response.result);
  if (!result) {
    throw new Error("Full Bun iOS bridge returned an invalid HTTP response");
  }
  emitIosLocalAgentDebug({
    step: "transport-result-normalized",
    method: options.method,
    path: options.path,
    status: result.status,
  });
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

function nativeResultToResponse(
  result: IosLocalAgentNativeRequestResult,
): Response {
  const body =
    result.status === 204 || result.status === 205 || result.status === 304
      ? null
      : result.body;
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

export async function handleIosLocalAgentNativeRequest(
  options: IosLocalAgentNativeRequestOptions,
): Promise<IosLocalAgentNativeRequestResult> {
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

  const fullBunResult = await tryFullBunNativeRequest({
    ...options,
    method,
    path,
  });
  if (fullBunResult) return fullBunResult;

  startIosLocalAgentKernel();
  const response = await handleIosLocalAgentRequest(
    new Request(`http://127.0.0.1:31337${path}`, {
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
  window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__ = handleIosLocalAgentNativeRequest;
  globalRequestHandlerInstalled = true;
}

function shouldBridgeFetchUrl(url: URL): boolean {
  if (!isNativeIos()) return false;
  if (isMobileLocalAgentUrl(url.toString())) return true;
  if (url.pathname.startsWith("/api/")) {
    return isIosInProcessLocalAgentBase(getElizaApiBase());
  }
  return false;
}

function localAgentUrlForFetch(url: URL): string {
  if (isMobileLocalAgentUrl(url.toString())) return url.toString();
  return `http://127.0.0.1:31337${url.pathname}${url.search}`;
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

installIosLocalAgentNativeRequestBridge();
installIosLocalAgentFetchBridge();
