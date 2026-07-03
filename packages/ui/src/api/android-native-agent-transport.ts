import { Capacitor } from "@capacitor/core";
import { getBootConfig } from "../config/boot-config";
import { isAndroidLocalAgentUrl } from "../first-run/local-agent-token";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  isMobileLocalAgentIpcUrl,
  mobileLocalAgentPathFromUrl,
} from "../first-run/mobile-runtime-mode";
import {
  createNativeStreamingResponse,
  type NativeStreamingAgentPlugin,
  supportsNativeStreaming,
} from "./native-agent-stream";
import {
  type AgentRequestTransport,
  bodyToString,
  fetchAgentTransport,
  headersToRecord,
  isStreamingRequest,
  methodAllowsBody,
} from "./transport";

export interface NativeAgentRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

export interface NativeAgentRequestResult {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
  /**
   * Lossless base64 of the raw response bytes. Preferred over `body` so binary
   * payloads (e.g. local TTS WAV audio) survive the bridge — `body` is a
   * best-effort UTF-8 view that mangles non-text bytes into U+FFFD.
   */
  bodyBase64?: string | null;
  bodyEncoding?: string;
}

type NativeAgentPlugin = {
  start?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
  getStatus?: () => Promise<unknown>;
  request?: (
    options: NativeAgentRequestOptions,
  ) => Promise<NativeAgentRequestResult>;
  // Streaming bridge (newer native plugin). When present, SSE requests stream
  // token-by-token instead of buffering the whole body. See native-agent-stream.
  requestStream?: (
    options: NativeAgentRequestOptions,
  ) => Promise<{ streamId: string }>;
  addListener?: (
    eventName: string,
    listener: (event: unknown) => void,
  ) => Promise<{ remove: () => void | Promise<void> }>;
};

const agentPluginName = "Agent";

let nativeTransportPromise: Promise<AgentRequestTransport | null> | null = null;
let globalFetchBridgeInstalled = false;
let originalFetch: typeof fetch | null = null;

type FetchWithOptionalPreconnect = typeof fetch & {
  preconnect?: (...args: unknown[]) => unknown;
};

function toNativeAgentPlugin(
  plugin: NativeAgentPlugin | null | undefined,
): NativeAgentPlugin | null {
  if (!plugin) return null;
  const start = plugin.start?.bind(plugin);
  const stop = plugin.stop?.bind(plugin);
  const getStatus = plugin.getStatus?.bind(plugin);
  const request = plugin.request?.bind(plugin);
  const requestStream = plugin.requestStream?.bind(plugin);
  const addListener = plugin.addListener?.bind(plugin);
  if (!start && !stop && !getStatus && !request) return null;
  return { start, stop, getStatus, request, requestStream, addListener };
}

function isNativeAndroid(): boolean {
  try {
    return Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
}

function isNativeIos(): boolean {
  try {
    return Capacitor.getPlatform() === "ios";
  } catch {
    return false;
  }
}

function isLocalAgentIpcUrl(value: string): boolean {
  return isMobileLocalAgentIpcUrl(value);
}

function localAgentPathFromUrl(value: string): string | null {
  return mobileLocalAgentPathFromUrl(value);
}

function shouldAttemptNativeAgentTransport(url: string): boolean {
  if (!isAndroidLocalAgentUrl(url)) return false;
  if (isNativeAndroid()) return true;
  return isLocalAgentIpcUrl(url) && !isNativeIos();
}

function readRuntimeMode(): string | null {
  try {
    const persisted = globalThis.localStorage?.getItem(
      "eliza:mobile-runtime-mode",
    );
    if (persisted?.trim()) return persisted.trim();
  } catch {
    // localStorage can be unavailable in tests and early native startup.
  }
  const env = (
    import.meta as ImportMeta & {
      env?: Record<string, string | boolean | undefined>;
    }
  ).env;
  const androidRuntimeMode =
    typeof env?.VITE_ELIZA_ANDROID_RUNTIME_MODE === "string"
      ? env.VITE_ELIZA_ANDROID_RUNTIME_MODE.trim()
      : "";
  const mobileRuntimeMode =
    typeof env?.VITE_ELIZA_MOBILE_RUNTIME_MODE === "string"
      ? env.VITE_ELIZA_MOBILE_RUNTIME_MODE.trim()
      : "";
  return androidRuntimeMode || mobileRuntimeMode || null;
}

function configuredApiBaseIsAndroidLocal(): boolean {
  const bootBase = getBootConfig().apiBase?.trim();
  return !!bootBase && isAndroidLocalAgentUrl(bootBase);
}

async function resolveNativeAgentPlugin(): Promise<NativeAgentPlugin | null> {
  try {
    const capacitorWithPlugins = Capacitor as typeof Capacitor & {
      Plugins?: Record<string, NativeAgentPlugin | undefined>;
    };
    const registeredAgent =
      capacitorWithPlugins.Plugins?.[agentPluginName] ??
      Capacitor.registerPlugin<NativeAgentPlugin>(agentPluginName);
    const agent = toNativeAgentPlugin(registeredAgent);
    if (agent) return agent;
  } catch {
    return null;
  }

  return null;
}

function shouldBridgeFetchUrl(url: URL, rawUrl: string): boolean {
  if (
    (isLocalAgentIpcUrl(rawUrl) || isLocalAgentIpcUrl(url.toString())) &&
    !isNativeIos()
  ) {
    return true;
  }
  if (!isNativeAndroid()) return false;
  if (
    isAndroidLocalAgentUrl(rawUrl) ||
    isAndroidLocalAgentUrl(url.toString())
  ) {
    return true;
  }
  if (!url.pathname.startsWith("/api/")) return false;
  return readRuntimeMode() === "local" || configuredApiBaseIsAndroidLocal();
}

function localAgentUrlForFetch(url: URL, rawUrl: string): string {
  if (isAndroidLocalAgentUrl(rawUrl)) return rawUrl;
  if (isAndroidLocalAgentUrl(url.toString())) return url.toString();
  return `${ANDROID_LOCAL_AGENT_IPC_BASE}${url.pathname}${url.search}`;
}

function localAgentRequestPath(url: string): string {
  const ipcPath = localAgentPathFromUrl(url);
  if (ipcPath !== null) return ipcPath;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

async function normalizeFetchBridgeInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<RequestInit | null> {
  const request = input instanceof Request ? input.clone() : null;
  const method = (init?.method ?? request?.method ?? "GET")
    .trim()
    .toUpperCase();
  const headers = init?.headers ?? request?.headers;
  if (!methodAllowsBody(method)) {
    return {
      ...init,
      method,
      headers,
      body: undefined,
    };
  }

  if (init && "body" in init) {
    const body = bodyToString(init.body);
    if (body === undefined && init.body != null) return null;
    return {
      ...init,
      method,
      headers,
      body: body ?? undefined,
    };
  }

  if (!request) {
    return {
      ...init,
      method,
      headers,
    };
  }

  const body = await request.text();
  return {
    ...init,
    method,
    headers,
    body: body || undefined,
  };
}

export function createAndroidNativeAgentTransport(
  agent: NativeAgentPlugin,
): AgentRequestTransport {
  return {
    async request(url, init, context) {
      if (!isAndroidLocalAgentUrl(url)) {
        return fetchAgentTransport.request(url, init);
      }
      const request = agent.request;
      if (!request) {
        return createNativeAgentUnavailableResponse(
          "Android local-agent IPC is unavailable because Agent.request is not registered",
        );
      }

      const method = init.method ?? "GET";
      const rawBody = init.body;
      const body = bodyToString(init.body);

      if (
        (body === undefined && rawBody != null) ||
        (!methodAllowsBody(method) && body != null)
      ) {
        return createNativeAgentUnavailableResponse(
          "Android local-agent IPC only supports string request bodies",
        );
      }

      // SSE requests (the chat reply token stream) go through the streaming
      // bridge so tokens reach the WebView incrementally instead of buffering
      // the whole body. Falls through to the buffered `request` below if the
      // native plugin has no streaming bridge or the stream fails to start.
      if (
        isStreamingRequest(url, init.headers) &&
        supportsNativeStreaming(agent)
      ) {
        try {
          return await createNativeStreamingResponse(
            agent as NativeStreamingAgentPlugin,
            {
              method,
              path: localAgentRequestPath(url),
              headers: headersToRecord(init.headers),
              body: methodAllowsBody(method) ? (body ?? null) : null,
              timeoutMs: context?.timeoutMs,
            },
          );
        } catch {
          // Stream couldn't start — fall back to the buffered request path.
        }
      }

      const result = await request({
        method,
        path: localAgentRequestPath(url),
        headers: headersToRecord(init.headers),
        body: methodAllowsBody(method) ? (body ?? null) : null,
        timeoutMs: context?.timeoutMs,
      });

      return new Response(nativeResponseBody(result), {
        status: result.status,
        statusText: result.statusText ?? "",
        headers: result.headers,
      });
    },
  };
}

/**
 * Reconstruct the response body from the native bridge result. Prefer the
 * lossless `bodyBase64` (raw bytes) so binary payloads survive; fall back to the
 * UTF-8 `body` string when the native side did not supply base64.
 */
function nativeResponseBody(
  result: NativeAgentRequestResult,
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
  return result.body ?? "";
}

function createNativeAgentUnavailableResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: "native_agent_unavailable",
      message,
    }),
    {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "application/json" },
    },
  );
}

export async function androidNativeAgentLifecycleForUrl(
  url: string | null | undefined,
): Promise<NativeAgentPlugin | null> {
  if (!url || !shouldAttemptNativeAgentTransport(url)) return null;
  return resolveNativeAgentPlugin();
}

export async function androidNativeAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  if (!shouldAttemptNativeAgentTransport(url)) return null;

  nativeTransportPromise ??= resolveNativeAgentPlugin()
    .then((agent) =>
      agent?.request ? createAndroidNativeAgentTransport(agent) : null,
    )
    .catch(() => null);

  const transport = await nativeTransportPromise;
  if (transport) return transport;
  nativeTransportPromise = null;
  if (!isLocalAgentIpcUrl(url)) return null;
  return {
    request: async () =>
      createNativeAgentUnavailableResponse(
        "Android local-agent IPC is unavailable because the native Agent plugin is not registered",
      ),
  };
}

export function installAndroidNativeAgentFetchBridge(): void {
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

    const rawUrl = input instanceof Request ? input.url : String(input);
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

    if (!shouldBridgeFetchUrl(url, rawUrl)) return original(input, init);

    const bridgedUrl = localAgentUrlForFetch(url, rawUrl);
    const bridgedInit = await normalizeFetchBridgeInit(input, init);
    if (!bridgedInit) {
      return isLocalAgentIpcUrl(bridgedUrl)
        ? createNativeAgentUnavailableResponse(
            "Android local-agent IPC only supports string request bodies",
          )
        : original(input, init);
    }

    const transport = await androidNativeAgentTransportForUrl(bridgedUrl);
    if (!transport) {
      return isLocalAgentIpcUrl(bridgedUrl)
        ? createNativeAgentUnavailableResponse(
            "Android local-agent IPC is unavailable because the native Agent transport is not registered",
          )
        : original(input, init);
    }
    return transport.request(bridgedUrl, bridgedInit);
  }) as typeof fetch;

  const nativeFetchWithPreconnect = nativeFetch as FetchWithOptionalPreconnect;
  if (typeof nativeFetchWithPreconnect.preconnect === "function") {
    (bridgedFetch as FetchWithOptionalPreconnect).preconnect =
      nativeFetchWithPreconnect.preconnect.bind(nativeFetch);
  }
  globalThis.fetch = bridgedFetch;
  globalFetchBridgeInstalled = true;
}

export function __resetAndroidNativeAgentTransportForTests(): void {
  nativeTransportPromise = null;
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }
  originalFetch = null;
  globalFetchBridgeInstalled = false;
}
