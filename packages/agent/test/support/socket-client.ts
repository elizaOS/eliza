// spec/agent/access/transport.md, "Story: Answer each local request exactly once"; spec/agent/access/transport.md, "Story: Stream a response and end it once"; spec/agent/conversation/events.md, "Story: Hear about my conversations while my screen is open"
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

export interface LocalRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export type Refusal = { readonly refused: string };

export interface LocalAnswer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly json: unknown;
}

export interface StreamedAnswer extends LocalAnswer {
  readonly chunks: readonly string[];
  readonly error: string | undefined;
}

export interface Subscription {
  readonly frames: readonly unknown[];
  next(predicate?: (frame: unknown) => boolean): Promise<unknown>;
  close(): void;
}

type Frame = Record<string, unknown>;

function isFrame(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function payloadOf(request: LocalRequest): Frame {
  const headers: Record<string, string> = { ...request.headers };
  if (request.token !== undefined) headers.authorization = `Bearer ${request.token}`;
  if (request.body !== undefined) headers["content-type"] ??= "application/json";
  return {
    path: request.path,
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: typeof request.body === "string" ? request.body : JSON.stringify(request.body) }),
  };
}

function headersOf(frame: Frame): Record<string, string> {
  const raw = isFrame(frame.headers) ? frame.headers : {};
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name.toLowerCase(), String(value)]));
}

function bodyText(result: Frame): string {
  if (typeof result.bodyBase64 === "string") return Buffer.from(result.bodyBase64, "base64").toString("utf8");
  return typeof result.body === "string" ? result.body : "";
}

function frames(socket: Socket, onFrame: (frame: Frame) => void): Promise<void> {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => {
    pending += data;
    let newline = pending.indexOf("\n");
    try {
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line !== "") {
          const parsed = parseJson(line);
          if (!isFrame(parsed)) throw new TypeError(`socket sent a line that is not a JSON object: ${line}`);
          onFrame(parsed);
        }
        newline = pending.indexOf("\n");
      }
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("close", () => resolve());
  });
}

function open(socketPath: string, line: string): Socket {
  const socket = connect(socketPath);
  socket.once("connect", () => socket.write(`${line}\n`));
  return socket;
}

export async function sendRaw(socketPath: string, line: string): Promise<Frame[]> {
  const received: Frame[] = [];
  const socket = open(socketPath, line);
  await frames(socket, (frame) => received.push(frame));
  return received;
}

export async function request(socketPath: string, call: LocalRequest): Promise<LocalAnswer | Refusal> {
  const id = randomUUID();
  const [answer, ...rest] = await sendRaw(socketPath, JSON.stringify({ id, method: "http_request", payload: payloadOf(call) }));
  if (answer === undefined || rest.length > 0) throw new TypeError(`expected one answer frame, got ${rest.length + (answer ? 1 : 0)}`);
  if (answer.id !== id) throw new TypeError(`answer for another request ${JSON.stringify(answer)}`);
  if (answer.ok === false) return { refused: typeof answer.error === "string" ? answer.error : JSON.stringify(answer.error) };
  if (answer.ok !== true || !isFrame(answer.result)) throw new TypeError(`unexpected answer frame ${JSON.stringify(answer)}`);
  const text = bodyText(answer.result);
  return { status: Number(answer.result.status), headers: headersOf(answer.result), text, json: parseJson(text) };
}

export async function requestStream(socketPath: string, call: LocalRequest, abortAfterChunks?: number): Promise<StreamedAnswer> {
  const id = randomUUID();
  const chunks: string[] = [];
  let head: Frame | undefined;
  let terminal: Frame | undefined;
  const socket = open(socketPath, JSON.stringify({ id, method: "http_request_stream", payload: payloadOf(call) }));
  await frames(socket, (frame) => {
    if (frame.id !== id) throw new TypeError(`frame for another request ${JSON.stringify(frame)}`);
    if (terminal !== undefined) throw new TypeError(`frame after the terminal frame ${JSON.stringify(frame)}`);
    if (frame.stream === "response") head = frame;
    else if (frame.stream === "chunk") {
      chunks.push(typeof frame.dataBase64 === "string" ? Buffer.from(frame.dataBase64, "base64").toString("utf8") : String(frame.data ?? ""));
      if (abortAfterChunks !== undefined && chunks.length >= abortAfterChunks) socket.destroy();
    } else if (frame.stream === "complete") terminal = frame;
    else throw new TypeError(`unknown stream frame ${JSON.stringify(frame)}`);
  });
  const text = chunks.join("");
  return {
    status: head === undefined ? 0 : Number(head.status),
    headers: head === undefined ? {} : headersOf(head),
    text,
    json: parseJson(text),
    chunks,
    error: terminal === undefined ? "closed before complete" : typeof terminal.error === "string" ? terminal.error : undefined,
  };
}

export function subscribe(socketPath: string, options: { streams: readonly string[]; clientId?: string }): Subscription {
  const id = randomUUID();
  const received: unknown[] = [];
  const waiters: Array<{ predicate: (frame: unknown) => boolean; resolve: (frame: unknown) => void; reject: (error: Error) => void }> = [];
  let delivered = 0;
  const socket = open(socketPath, JSON.stringify({
    id,
    method: "events_subscribe",
    payload: { streams: options.streams, ...(options.clientId === undefined ? {} : { clientId: options.clientId }) },
  }));
  const settle = () => {
    for (const waiter of [...waiters]) {
      const found = received.slice(delivered).find(waiter.predicate);
      if (found !== undefined) {
        delivered = received.indexOf(found) + 1;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(found);
      }
    }
  };
  frames(socket, (frame) => {
    received.push(frame);
    settle();
  }).then(
    () => {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error("event subscription closed"));
    },
    (error: Error) => {
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    },
  );
  return {
    frames: received,
    next: (predicate = () => true) =>
      new Promise((resolve, reject) => {
        waiters.push({ predicate, resolve, reject });
        settle();
      }),
    close: () => socket.destroy(),
  };
}
