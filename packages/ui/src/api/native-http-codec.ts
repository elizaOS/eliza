/**
 * Canonical byte and response codec for HTTP results crossing native string
 * bridges. Platform transports own routing and IPC, while this module owns
 * exact binary decoding and Fetch Response construction.
 */

export interface NativeHttpResult {
  status: number;
  statusText?: string;
  headers?: HeadersInit;
  body?: string | null;
  bodyBase64?: string | null;
}

const BODYLESS_STATUS = new Set([204, 205, 304]);

export function decodeNativeBase64(value: string): ArrayBuffer {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function nativeHttpResultBody(
  result: Pick<NativeHttpResult, "body" | "bodyBase64">,
): ArrayBuffer | string {
  return typeof result.bodyBase64 === "string" && result.bodyBase64.length > 0
    ? decodeNativeBase64(result.bodyBase64)
    : (result.body ?? "");
}

export function nativeHttpResultToResponse(result: NativeHttpResult): Response {
  return new Response(
    BODYLESS_STATUS.has(result.status) ? null : nativeHttpResultBody(result),
    {
      status: result.status,
      statusText: result.statusText ?? "",
      headers: result.headers,
    },
  );
}

export type NativeFetchRequestClass =
  | { kind: "invalid" }
  | { kind: "relative-api"; path: string }
  | { kind: "absolute"; url: URL };

export function nativeJsonRequestData(
  body: BodyInit | null | undefined,
): unknown {
  if (body == null) return undefined;
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return body;
  }
}
