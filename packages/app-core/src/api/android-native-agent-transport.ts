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

let nativeTransportPromise: Promise<AgentRequestTransport | null> | null = null;

function isNativeAndroid(): boolean {
  try {
    return (
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"
    );
  } catch {
    return false;
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

  nativeTransportPromise ??= import(/* @vite-ignore */ agentPluginId)
    .then((mod: { Agent?: NativeAgentPlugin }) =>
      mod.Agent ? createAndroidNativeAgentTransport(mod.Agent) : null,
    )
    .catch(() => null);

  return nativeTransportPromise;
}
