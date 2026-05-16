import { Capacitor } from "@capacitor/core";
import { getBootConfig } from "../config/boot-config";
import { isAndroidLocalAgentUrl } from "../onboarding/local-agent-token";
import { type AgentRequestTransport, fetchAgentTransport } from "./transport";

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
}

type NativeAgentPlugin = {
  start?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
  getStatus?: () => Promise<unknown>;
  request?: (
    options: NativeAgentRequestOptions,
  ) => Promise<NativeAgentRequestResult>;
};

const agentPluginId = "@elizaos/capacitor-agent";
const agentPluginName = "Agent";
const androidLocalAgentIpcBase = "eliza-local-agent://ipc";
const localAgentIpcProtocol = "eliza-local-agent:";
const localAgentIpcHost = "ipc";

let nativeTransportPromise: Promise<AgentRequestTransport | null> | null = null;
let globalFetchBridgeInstalled = false;
let originalFetch: typeof fetch | null = null;

type FetchWithOptionalPreconnect = typeof fetch & {
  preconnect?: (...args: unknown[]) => unknown;
};

declare global {
  interface Window {
    __ELIZA_API_BASE__?: string;
    __ELIZAOS_API_BASE__?: string;
  }
}

function toNativeAgentPlugin(
  plugin: NativeAgentPlugin | null | undefined,
): NativeAgentPlugin | null {
  if (!plugin) return null;
  const start = plugin.start?.bind(plugin);
  const stop = plugin.stop?.bind(plugin);
  const getStatus = plugin.getStatus?.bind(plugin);
  const request = plugin.request?.bind(plugin);
  if (!start && !stop && !getStatus && !request) return null;
  return { start, stop, getStatus, request };
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
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === localAgentIpcProtocol &&
      parsed.hostname === localAgentIpcHost
    );
  } catch {
    return false;
  }
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
  const env = (import.meta as ImportMeta & {
    env?: Record<string, string | boolean | undefined>;
  }).env;
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
  if (bootBase && isAndroidLocalAgentUrl(bootBase)) return true;
  if (typeof window === "undefined") return false;
  const primary = window.__ELIZA_API_BASE__?.trim();
  if (primary && isAndroidLocalAgentUrl(primary)) return true;
  const branded = window.__ELIZAOS_API_BASE__?.trim();
  return !!branded && isAndroidLocalAgentUrl(branded);
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
    // Fall through to the package import for browser/package-mode test builds.
  }

  try {
    const mod = (await import(/* @vite-ignore */ agentPluginId)) as {
      Agent?: NativeAgentPlugin;
    };
    return toNativeAgentPlugin(mod.Agent);
  } catch {
    return null;
  }
}

function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function methodAllowsBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function bodyToString(
  body: BodyInit | null | undefined,
): string | null | undefined {
  if (body === null) return null;
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

function shouldBridgeFetchUrl(url: URL): boolean {
  if (isLocalAgentIpcUrl(url.toString()) && !isNativeIos()) return true;
  if (!isNativeAndroid()) return false;
  if (isAndroidLocalAgentUrl(url.toString())) return true;
  if (!url.pathname.startsWith("/api/")) return false;
  return readRuntimeMode() === "local" || configuredApiBaseIsAndroidLocal();
}

function localAgentUrlForFetch(url: URL): string {
  if (isAndroidLocalAgentUrl(url.toString())) return url.toString();
  return `${androidLocalAgentIpcBase}${url.pathname}${url.search}`;
}

async function normalizeFetchBridgeInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<RequestInit | null> {
  const request = input instanceof Request ? input.clone() : null;
  const method = (init?.method ?? request?.method ?? "GET").trim().toUpperCase();
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

      const parsed = new URL(url);
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

      const result = await request({
        method,
        path: `${parsed.pathname}${parsed.search}`,
        headers: headersToRecord(init.headers),
        body: methodAllowsBody(method) ? (body ?? null) : null,
        timeoutMs: context?.timeoutMs,
      });

      return new Response(result.body ?? "", {
        status: result.status,
        statusText: result.statusText ?? "",
        headers: result.headers,
      });
    },
  };
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

    if (!shouldBridgeFetchUrl(url)) return original(input, init);

    const bridgedUrl = localAgentUrlForFetch(url);
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
