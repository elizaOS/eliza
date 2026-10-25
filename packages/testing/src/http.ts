/**
 * Shared HTTP helper for e2e tests.
 */

import http from "node:http";

export type HttpResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  data: Record<string, unknown>;
};

export type HttpRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export function readConversationId(data: Record<string, unknown>): string {
  const conversation =
    data.conversation &&
    typeof data.conversation === "object" &&
    !Array.isArray(data.conversation)
      ? (data.conversation as Record<string, unknown>)
      : null;
  const id = typeof conversation?.id === "string" ? conversation.id : "";
  if (!id) {
    throw new Error("Conversation response did not include an id");
  }
  return id;
}

/**
 * Make an HTTP request to a local test server.
 */
export function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown> | string,
  headersOrContentType?: Record<string, string> | string,
  options?: HttpRequestOptions,
): Promise<HttpResponse> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(
      new RangeError("HTTP fixture timeoutMs must be positive and finite"),
    );
  }
  return new Promise((resolve, reject) => {
    const contentType =
      typeof headersOrContentType === "string"
        ? headersOrContentType
        : "application/json";
    const extraHeaders =
      typeof headersOrContentType === "object" ? headersOrContentType : {};

    const b =
      body !== undefined
        ? typeof body === "string"
          ? body
          : JSON.stringify(body)
        : undefined;

    let settled = false;
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    const succeed = (response: HttpResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(response);
    };

    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        signal: options?.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": contentType,
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("error", fail);
        res.on("aborted", () =>
          fail(new Error(`Response aborted: ${method.toUpperCase()} ${path}`)),
        );
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          succeed({ status: res.statusCode ?? 0, headers: res.headers, data });
        });
      },
    );
    r.on("error", fail);
    if (b) r.write(b);
    r.end();
  });
}

export async function createConversation(
  port: number,
  options?: { title?: string; includeGreeting?: boolean; lang?: string },
  headersOrContentType?: Record<string, string> | string,
  requestOptions?: HttpRequestOptions,
): Promise<HttpResponse & { conversationId: string }> {
  const response = await req(
    port,
    "POST",
    "/api/conversations",
    options,
    headersOrContentType,
    requestOptions,
  );
  return {
    ...response,
    conversationId: readConversationId(response.data),
  };
}

export function postConversationMessage(
  port: number,
  conversationId: string,
  body?: Record<string, unknown> | string,
  headersOrContentType?: Record<string, string> | string,
  requestOptions?: HttpRequestOptions,
): Promise<HttpResponse> {
  return req(
    port,
    "POST",
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    body,
    headersOrContentType,
    requestOptions,
  );
}
