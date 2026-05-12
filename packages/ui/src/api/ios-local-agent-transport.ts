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
let fullBunRuntime: Promise<FullBunRuntimePlugin | null> | null = null;

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

interface FullBunRuntimePlugin {
  start(options: {
    engine: "bun";
    argv?: string[];
    env?: Record<string, string>;
  }): Promise<{ ok: boolean; error?: string }>;
  getStatus(): Promise<{ ready: boolean; engine?: "bun" | "compat" }>;
  call(options: { method: string; args?: unknown }): Promise<{ result: unknown }>;
}

interface FullBunRuntimeModule {
  ElizaBunRuntime: FullBunRuntimePlugin;
}

declare global {
  interface Window {
    __ELIZA_IOS_LOCAL_AGENT_REQUEST__?: (
      options: IosLocalAgentNativeRequestOptions,
    ) => Promise<IosLocalAgentNativeRequestResult>;
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

async function getFullBunRuntime(): Promise<FullBunRuntimePlugin | null> {
  if (!isNativeIos()) return null;
  if (!isFullBunRuntimePluginAvailable()) return null;
  fullBunRuntime ??= (async () => {
    try {
      const mod = (await import(
        "@elizaos/capacitor-bun-runtime"
      )) as FullBunRuntimeModule;
      const runtime = mod.ElizaBunRuntime;
      const started = await runtime.start({
        engine: "bun",
        argv: ["bun", "public/agent/agent-bundle.js", "ios-bridge", "--stdio"],
        env: {
          ELIZA_PLATFORM: "ios",
          ELIZA_MOBILE_PLATFORM: "ios",
          ELIZA_IOS_LOCAL_BACKEND: "1",
          ELIZA_HEADLESS: "1",
          ELIZA_API_BIND: "127.0.0.1",
          LOG_LEVEL: "error",
        },
      });
      if (!started.ok) return null;
      const status = await runtime.getStatus();
      if (!status.ready || status.engine !== "bun") return null;
      return runtime;
    } catch {
      return null;
    }
  })();
  return fullBunRuntime;
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
    body:
      method === "GET" || method === "HEAD" ? null : await request.text(),
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
