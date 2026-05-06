import { Capacitor } from "@capacitor/core";
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
  request?: (
    options: NativeAgentRequestOptions,
  ) => Promise<NativeAgentRequestResult>;
};

const agentPluginId = "@elizaos/capacitor-agent";
const agentPluginName = "Agent";

let nativeTransportPromise: Promise<AgentRequestTransport | null> | null = null;

function toNativeAgentPlugin(
  plugin: NativeAgentPlugin | null | undefined,
): NativeAgentPlugin | null {
  if (!plugin?.request) return null;
  const request = plugin.request.bind(plugin);
  return { request };
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
        return fetchAgentTransport.request(url, init);
      }

      const parsed = new URL(url);
      const method = init.method ?? "GET";
      const rawBody = init.body;
      const body = bodyToString(init.body);

      if (
        (body === undefined && rawBody != null) ||
        (!methodAllowsBody(method) && body != null)
      ) {
        return fetchAgentTransport.request(url, init);
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

export async function androidNativeAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  if (!isAndroidLocalAgentUrl(url) || !isNativeAndroid()) return null;

  nativeTransportPromise ??= resolveNativeAgentPlugin()
    .then((agent) => (agent ? createAndroidNativeAgentTransport(agent) : null))
    .catch(() => null);

  return nativeTransportPromise;
}
