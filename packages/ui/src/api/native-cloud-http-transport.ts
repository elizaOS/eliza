import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { type AgentRequestTransport, fetchAgentTransport } from "./transport";

const DIRECT_CLOUD_API_HOSTS = new Set(["api.elizacloud.ai"]);

function isNativeDirectCloudApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      Capacitor.isNativePlatform() &&
      parsed.protocol === "https:" &&
      DIRECT_CLOUD_API_HOSTS.has(parsed.hostname.toLowerCase())
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

function bodyToNativeData(body: BodyInit | null | undefined): unknown {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

function responseBody(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}

const nativeCloudHttpTransport: AgentRequestTransport = {
  async request(url, init, context) {
    if (!isNativeDirectCloudApiUrl(url)) {
      return fetchAgentTransport.request(url, init, context);
    }

    const method = init.method ?? "GET";
    const data = bodyToNativeData(init.body);
    if (init.body != null && data === undefined) {
      return fetchAgentTransport.request(url, init, context);
    }

    const result = await CapacitorHttp.request({
      url,
      method,
      headers: headersToRecord(init.headers),
      ...(methodAllowsBody(method) && data !== undefined ? { data } : {}),
      responseType: "text",
      ...(context?.timeoutMs
        ? {
            connectTimeout: context.timeoutMs,
            readTimeout: context.timeoutMs,
          }
        : {}),
    });

    return new Response(responseBody(result.data), {
      status: result.status,
      headers: result.headers,
    });
  },
};

export function nativeCloudHttpTransportForUrl(
  url: string,
): AgentRequestTransport | null {
  return isNativeDirectCloudApiUrl(url) ? nativeCloudHttpTransport : null;
}
