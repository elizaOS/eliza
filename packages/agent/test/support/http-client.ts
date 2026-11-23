// spec/agent/access/transport.md, "Story: Answer each local request exactly once"; spec/agent/access/transport.md, "Story: Stream a response and end it once"; spec/agent/conversation/events.md, "Story: Hear about my conversations while my screen is open"
import type { LocalAnswer, LocalRequest, StreamCut, StreamedAnswer, Subscription } from "./socket-client.ts";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function init(call: LocalRequest, signal?: AbortSignal): RequestInit {
  const headers: Record<string, string> = { ...call.headers };
  if (call.token !== undefined) headers.authorization = `Bearer ${call.token}`;
  if (call.body !== undefined) headers["content-type"] ??= "application/json";
  return {
    method: call.method,
    headers,
    ...(call.body === undefined ? {} : { body: typeof call.body === "string" ? call.body : JSON.stringify(call.body) }),
    ...(signal === undefined ? {} : { signal }),
  };
}

const origin = (port: number): string => `http://127.0.0.1:${port}`;
const headersOf = (response: Response): Record<string, string> => Object.fromEntries(response.headers);

export async function httpRequest(port: number, call: LocalRequest): Promise<LocalAnswer> {
  const response = await fetch(`${origin(port)}${call.path}`, init(call));
  const text = await response.text();
  return { status: response.status, headers: headersOf(response), text, json: parseJson(text) };
}

export async function httpRequestStream(port: number, call: LocalRequest, leave?: StreamCut, opened?: (status: number) => void): Promise<StreamedAnswer> {
  const cut = new AbortController();
  const response = await fetch(`${origin(port)}${call.path}`, init(call, cut.signal));
  opened?.(response.status);
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let error: string | undefined;
  if (response.body !== null) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
        if (leave !== undefined && chunks.length >= leave.afterChunks) {
          await leave.ready;
          cut.abort();
          error = "closed before complete";
          break;
        }
      }
    } catch {
      error = "closed before complete";
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  const text = chunks.join("");
  return { status: response.status, headers: headersOf(response), text, json: parseJson(text), chunks, error };
}

export function httpSubscribe(port: number, options: { streams: readonly string[]; clientId?: string; token?: string }): Subscription {
  const received: unknown[] = [];
  const waiters: Array<{ predicate: (frame: unknown) => boolean; resolve: (frame: unknown) => void; reject: (error: Error) => void }> = [];
  let delivered = 0;
  let ended: Error | undefined;
  const cut = new AbortController();
  const settle = () => {
    for (const waiter of [...waiters]) {
      const found = received.slice(delivered).find(waiter.predicate);
      if (found !== undefined) {
        delivered = received.indexOf(found) + 1;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(found);
      } else if (ended !== undefined) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.reject(ended);
      }
    }
  };
  const query = new URLSearchParams({ streams: options.streams.join(","), ...(options.clientId === undefined ? {} : { clientId: options.clientId }) });
  const listen = async () => {
    const response = await fetch(`${origin(port)}/api/events?${query}`, {
      headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
      signal: cut.signal,
    });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`event subscription refused with ${response.status}: ${await response.text()}`);
    }
    const decoder = new TextDecoder();
    let pending = "";
    for await (const part of response.body) {
      pending += decoder.decode(part, { stream: true });
      let boundary = pending.indexOf("\n\n");
      while (boundary >= 0) {
        const message = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = message.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data !== "") {
          const frame = parseJson(data);
          if (frame === undefined) throw new TypeError(`event stream sent data that is not JSON: ${data}`);
          received.push(frame);
          settle();
        }
        boundary = pending.indexOf("\n\n");
      }
    }
  };
  listen().then(
    () => {
      ended = new Error("event subscription closed");
      settle();
    },
    (error: unknown) => {
      ended = error instanceof Error ? error : new Error(String(error));
      settle();
    },
  );
  return {
    frames: received,
    next: (predicate = () => true) =>
      new Promise((resolve, reject) => {
        waiters.push({ predicate, resolve, reject });
        settle();
      }),
    close: () => cut.abort(),
  };
}
