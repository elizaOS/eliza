/**
 * The AgentRequestTransport interface and the default fetch-backed
 * implementation, plus the small helpers (body/header coercion, method rules)
 * the platform-specific transports share.
 */
export interface AgentRequestTransport {
  request(
    url: string,
    init: RequestInit,
    context?: { timeoutMs?: number },
  ): Promise<Response>;
}

export const fetchAgentTransport: AgentRequestTransport = {
  request(url, init) {
    return fetch(url, init);
  },
};

// ---------------------------------------------------------------------------
// Shared transport helpers — used by every native/desktop transport so the
// HTTP plumbing has a single definition each (no per-file copies that drift).
// ---------------------------------------------------------------------------

export function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

export function methodAllowsBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

/**
 * Normalize a `BodyInit` into the scalar payload native bridges accept (they
 * cannot marshal streams/blobs). `null` is preserved distinct from `undefined`
 * so callers that care about an explicit empty body can tell them apart.
 */
export function bodyToString(
  body: BodyInit | null | undefined,
): string | null | undefined {
  if (body === null) return null;
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

/**
 * An SSE / streaming request — the chat reply's token stream. Detected by the
 * `Accept: text/event-stream` header or a `…/stream` path. Parsing with a base
 * resolves relative URLs too; the substring check is the final fallback.
 */
export function isStreamingRequest(
  url: string,
  headers: HeadersInit | undefined,
): boolean {
  const accept = new Headers(headers ?? {}).get("accept") ?? "";
  if (accept.toLowerCase().includes("text/event-stream")) return true;
  try {
    return new URL(url, "http://localhost").pathname.endsWith("/stream");
  } catch {
    return url.includes("/stream");
  }
}
