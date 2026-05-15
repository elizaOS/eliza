import { Capacitor } from "@capacitor/core";
import {
  isAndroidNativeLocalAgentUrl,
  parseMobileNativeLocalAgentUrl,
} from "./mobile-native-agent-url";
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
  start?: (options?: {
    apiBase?: string;
    mode?: "local" | "cloud" | "cloud-hybrid" | "remote-mac" | string;
  }) => Promise<unknown>;
  stop?: () => Promise<unknown>;
  getStatus?: () => Promise<unknown>;
  request?: (
    options: NativeAgentRequestOptions,
  ) => Promise<NativeAgentRequestResult>;
};

const agentPluginId = "@elizaos/capacitor-agent";
const agentPluginName = "Agent";

let nativeTransportPromise: Promise<AgentRequestTransport | null> | null = null;
let nativeStartPromise: Promise<unknown> | null = null;

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
    return (
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
    );
  } catch {
    return false;
  }
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

function jsonResponse(status: number, code: string, message: string): Response {
  return Response.json(
    {
      ok: false,
      error: code,
      message,
    },
    {
      status,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

async function startAndroidLocalAgent(
  agent: NativeAgentPlugin,
  apiBase: string,
  options?: Parameters<NonNullable<NativeAgentPlugin["start"]>>[0],
): Promise<unknown> {
  if (!agent.start) return null;

  nativeStartPromise ??= agent
    .start({
      ...options,
      apiBase: options?.apiBase ?? apiBase,
      mode: options?.mode ?? "local",
    })
    .catch((error) => {
      nativeStartPromise = null;
      throw error;
    });

  return nativeStartPromise;
}

async function ensureAndroidLocalAgentStarted(
  agent: NativeAgentPlugin,
  apiBase: string,
): Promise<void> {
  await startAndroidLocalAgent(agent, apiBase);
}

function createAndroidNativeAgentLifecycle(
  agent: NativeAgentPlugin,
  apiBase: string,
): NativeAgentPlugin {
  return {
    ...agent,
    start: agent.start
      ? (options) => startAndroidLocalAgent(agent, apiBase, options)
      : undefined,
    stop: agent.stop
      ? async () => {
          nativeStartPromise = null;
          return agent.stop?.();
        }
      : undefined,
  };
}

export function createAndroidNativeAgentTransport(
  agent: NativeAgentPlugin | null,
): AgentRequestTransport {
  return {
    async request(url, init, context) {
      const parsed = parseMobileNativeLocalAgentUrl(url);
      if (parsed?.kind !== "http-loopback") {
        return fetchAgentTransport.request(url, init);
      }

      if (!agent) {
        return jsonResponse(
          503,
          "android_native_agent_unavailable",
          "Android local-agent requests require the native Agent Capacitor plugin.",
        );
      }

      const request = agent.request;
      if (!request) {
        return jsonResponse(
          503,
          "android_native_agent_request_unavailable",
          "Android local-agent foreground requests require Agent.request native IPC.",
        );
      }

      const method = init.method ?? "GET";
      const rawBody = init.body;
      const body = bodyToString(init.body);

      if (body === undefined && rawBody != null) {
        return jsonResponse(
          415,
          "android_native_agent_unsupported_body",
          "Android local-agent native IPC currently accepts string and URLSearchParams request bodies only.",
        );
      }
      if (!methodAllowsBody(method) && body != null) {
        return jsonResponse(
          400,
          "android_native_agent_body_not_allowed",
          "GET and HEAD local-agent requests cannot include a request body.",
        );
      }

      await ensureAndroidLocalAgentStarted(agent, parsed.baseUrl);

      const result = await request({
        method,
        path: parsed.path,
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

export async function androidNativeAgentLifecycleForUrl(
  url: string | null | undefined,
): Promise<NativeAgentPlugin | null> {
  if (!url || !isAndroidNativeLocalAgentUrl(url) || !isNativeAndroid()) {
    return null;
  }
  const parsed = parseMobileNativeLocalAgentUrl(url);
  const agent = await resolveNativeAgentPlugin();
  return agent && parsed
    ? createAndroidNativeAgentLifecycle(agent, parsed.baseUrl)
    : null;
}

export async function androidNativeAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  if (!isAndroidNativeLocalAgentUrl(url) || !isNativeAndroid()) return null;

  nativeTransportPromise ??= resolveNativeAgentPlugin()
    .then((agent) => {
      if (!agent) {
        nativeTransportPromise = null;
      }
      return createAndroidNativeAgentTransport(agent);
    })
    .catch(() => {
      nativeTransportPromise = null;
      return createAndroidNativeAgentTransport(null);
    });

  return nativeTransportPromise;
}
