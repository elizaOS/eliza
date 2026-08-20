/**
 * The AgentRequestTransport interface and the default fetch-backed
 * implementation, plus the small helpers (body/header coercion, method rules)
 * the platform-specific transports share.
 */
export interface AgentRequestContext {
  timeoutMs?: number;
  responseType?: "text" | "arraybuffer";
}

export interface AgentRequestTransport {
  request(
    url: string,
    init: RequestInit,
    context?: AgentRequestContext,
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
 *
 * Returns `undefined` for body types the bridge cannot serialize as a string
 * (FormData, ArrayBuffer, Blob, etc.) — callers should check for `undefined`
 * and either fall back to `fetch` or use `bodyToBase64` for binary bodies.
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
 * Serialize a binary request body (FormData, ArrayBuffer, Blob, Uint8Array) to
 * a base64 string for transport through the Electrobun RPC bridge. Returns the
 * base64-encoded bytes and the Content-Type that the main process should set
 * when reconstructing the request body.
 *
 * For FormData, the multipart body is serialized using the Response constructor
 * (which produces the raw multipart bytes with boundary), and the Content-Type
 * header (including the boundary) is extracted from the serialized Response.
 *
 * Returns `null` when the body type is not recognized as binary.
 */
export async function bodyToBase64(
  body: BodyInit | null | undefined,
): Promise<{ bodyBase64: string; contentType: string } | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return null;
  if (body instanceof URLSearchParams) return null;

  // FormData → serialize to multipart bytes, capture Content-Type with boundary
  if (body instanceof FormData) {
    const response = new Response(body);
    const contentType = response.headers.get("content-type") ?? "multipart/form-data";
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
    }
    return { bodyBase64: btoa(binary), contentType };
  }

  // ArrayBuffer / ArrayBufferView → raw bytes
  if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
    }
    return { bodyBase64: btoa(binary), contentType: "application/octet-stream" };
  }

  if (ArrayBuffer.isView(body) && !(body instanceof DataView)) {
    const view = body as Uint8Array;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
    }
    return { bodyBase64: btoa(binary), contentType: "application/octet-stream" };
  }

  // Blob → read as array buffer
  if (body instanceof Blob) {
    const buffer = await body.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
    }
    return { bodyBase64: btoa(binary), contentType: body.type || "application/octet-stream" };
  }

  return null;
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
