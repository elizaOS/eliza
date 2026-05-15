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
  start?: () => Promise<unknown>;
  stop?: () => Promise<unknown>;
  getStatus?: () => Promise<unknown>;
  request?: (
    options: NativeAgentRequestOptions,
  ) => Promise<NativeAgentRequestResult>;
};

const agentPluginId = "@elizaos/capacitor-agent";
const agentPluginName = "Agent";

let nativeTransportPromise: Promise<AgentRequestTransport | null> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localUnavailableResponse(reason: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: "local-unavailable",
      code: "local-unavailable",
      reason,
      message,
    }),
    {
      status: 503,
      statusText: "Local Agent Unavailable",
      headers: { "content-type": "application/json" },
    },
  );
}

function createAndroidLocalUnavailableTransport(
  reason: string,
  message: string,
): AgentRequestTransport {
  return {
    async request(url, init) {
      if (!isAndroidLocalAgentUrl(url)) {
        return fetchAgentTransport.request(url, init);
      }
      return localUnavailableResponse(reason, message);
    },
  };
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

async function bodyToString(
  body: BodyInit | null | undefined,
): Promise<string | null | undefined> {
  if (body === null) return null;
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.text();
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
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
        return localUnavailableResponse(
          "native-agent-request-unavailable",
          "Android local-agent IPC requires the native Agent.request bridge.",
        );
      }

      const parsed = new URL(url);
      const method = init.method ?? "GET";
      const rawBody = init.body;
      const body = await bodyToString(init.body);

      if (body === undefined && rawBody != null) {
        return localUnavailableResponse(
          "unsupported-request-body",
          "Android local-agent IPC requires a string, URLSearchParams, Blob, ArrayBuffer, or typed-array request body.",
        );
      }

      if (!methodAllowsBody(method) && body != null) {
        return localUnavailableResponse(
          "request-body-not-allowed",
          "Android local-agent IPC cannot send a request body with GET or HEAD.",
        );
      }

      let result: NativeAgentRequestResult;
      try {
        result = await request({
          method,
          path: `${parsed.pathname}${parsed.search}`,
          headers: headersToRecord(init.headers),
          body: methodAllowsBody(method) ? (body ?? null) : null,
          timeoutMs: context?.timeoutMs,
        });
      } catch (error) {
        return localUnavailableResponse(
          "native-agent-request-failed",
          `Android local-agent IPC request failed: ${errorMessage(error)}`,
        );
      }

      if (typeof result.status !== "number") {
        return localUnavailableResponse(
          "native-agent-invalid-response",
          "Android local-agent IPC returned an invalid HTTP response.",
        );
      }

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
  if (!url || !isAndroidLocalAgentUrl(url) || !isNativeAndroid()) return null;
  return resolveNativeAgentPlugin();
}

export async function androidNativeAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  if (!isAndroidLocalAgentUrl(url) || !isNativeAndroid()) return null;

  nativeTransportPromise ??= resolveNativeAgentPlugin()
    .then((agent) =>
      agent
        ? createAndroidNativeAgentTransport(agent)
        : createAndroidLocalUnavailableTransport(
            "native-agent-plugin-unavailable",
            "Android local-agent IPC requires the native Agent Capacitor plugin.",
          ),
    )
    .catch((error) =>
      createAndroidLocalUnavailableTransport(
        "native-agent-plugin-failed",
        `Android local-agent IPC plugin resolution failed: ${errorMessage(error)}`,
      ),
    );

  return nativeTransportPromise;
}
