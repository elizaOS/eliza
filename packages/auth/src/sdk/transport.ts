function errorMessageRequiresMfa(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("recent mfa") ||
    normalized.includes("mfa step-up") ||
    normalized.includes("multi-factor") ||
    normalized.includes("mfa verification")
  );
}

export class LoginApiError<TData = unknown> extends Error {
  readonly status: number;
  readonly data?: TData;
  readonly mfaRequired: boolean;

  constructor(message: string, status: number, data?: TData) {
    super(message);
    this.name = "LoginApiError";
    this.status = status;
    this.data = data;
    this.mfaRequired =
      (typeof data === "object" &&
        data !== null &&
        "mfaRequired" in data &&
        (data as { mfaRequired?: unknown }).mfaRequired === true) ||
      errorMessageRequiresMfa(message);
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;

export function boundedPositiveInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new LoginApiError(
      `${name} must be a positive integer no greater than ${maximum}`,
      0,
    );
  }
  return resolved;
}

export interface LoginTransportOptions {
  requestTimeoutMs?: number;
  maxResponseBodyBytes?: number;
}

export async function fetchLoginText(
  url: string,
  init: RequestInit = {},
  options: LoginTransportOptions = {},
  prepareHeaders?: () => Promise<Headers>,
): Promise<{ response: Response; text: string }> {
  const requestTimeoutMs = boundedPositiveInteger(
    "requestTimeoutMs",
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
  );
  const maxResponseBodyBytes = boundedPositiveInteger(
    "maxResponseBodyBytes",
    options.maxResponseBodyBytes,
    DEFAULT_MAX_RESPONSE_BODY_BYTES,
    MAX_RESPONSE_BODY_BYTES,
  );
  const controller = new AbortController();
  const deadlineAt = Date.now() + requestTimeoutMs;
  const callerSignal = init.signal;
  let timedOut = false;
  let callerCancelled = callerSignal?.aborted ?? false;
  const cancelFromCaller = () => {
    callerCancelled = true;
    controller.abort();
  };
  callerSignal?.addEventListener("abort", cancelFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);

  try {
    if (callerCancelled)
      throw new DOMException("Request cancelled", "AbortError");
    const headers = prepareHeaders
      ? await prepareHeaders()
      : new Headers(init.headers);
    if (controller.signal.aborted)
      throw new DOMException("Request aborted", "AbortError");
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await readResponseText(
      response,
      controller.signal,
      maxResponseBodyBytes,
    );
    if (Date.now() >= deadlineAt) {
      timedOut = true;
      controller.abort();
      throw new DOMException("Request deadline elapsed", "AbortError");
    }
    return { response, text };
  } catch (error) {
    if (timedOut) throw new LoginApiError("login API request timed out", 0);
    if (callerCancelled)
      throw new LoginApiError("login API request was cancelled", 0);
    if (error instanceof LoginApiError) throw error;
    throw new LoginApiError("Network request failed", 0);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", cancelFromCaller);
  }
}

export async function fetchLoginJson<T>(
  url: string,
  init: RequestInit = {},
  options: LoginTransportOptions = {},
  prepareHeaders?: () => Promise<Headers>,
): Promise<{ response: Response; payload: T }> {
  const { response, text } = await fetchLoginText(
    url,
    init,
    options,
    prepareHeaders,
  );
  if (!text) return { response, payload: { ok: response.ok } as T };
  try {
    return { response, payload: JSON.parse(text) as T };
  } catch {
    throw new LoginApiError(
      "Received invalid JSON from login API",
      response.status,
    );
  }
}

async function readResponseText(
  response: Response,
  signal: AbortSignal,
  maxResponseBodyBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxResponseBodyBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new LoginApiError(
        "login API response exceeded the configured size limit",
        response.status,
      );
    }
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await readResponseChunk(reader, signal);
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBodyBytes) {
          void reader.cancel().catch(() => undefined);
          throw new LoginApiError(
            "login API response exceeded the configured size limit",
            response.status,
          );
        }
        chunks.push(value);
      }
    } finally {
      if (signal.aborted) void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // An abort may leave a hostile/custom stream's read pending. The
        // controller and cancel above still ensure this request stops waiting.
      }
    }
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(body);

  return text;
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<
  { done: false; value: Uint8Array } | { done: true; value?: Uint8Array }
> {
  if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("Request aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
