// spec/cloud/services/speechRelay.md, "Story: Speak the relay protocol on one socket"
import { request } from "node:http";

export type Received =
  | { readonly kind: "text"; readonly frame: Readonly<Record<string, unknown>> }
  | { readonly kind: "binary"; readonly bytes: Uint8Array }
  | { readonly kind: "close"; readonly code: number };

export interface RelaySocket {
  send(frame: Readonly<Record<string, unknown>> | Uint8Array): void;
  close(): void;
  next(): Promise<Received>;
  until(done: (received: Received) => boolean): Promise<ReadonlyArray<Received>>;
}

export function openRelay(base: string, sessionId: string): Promise<RelaySocket> {
  const url = new URL(`/api/v1/voice/speech/ws?sessionId=${encodeURIComponent(sessionId)}`, base.replace(/^http/, "ws"));
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const arrived: Received[] = [];
  const waiting: Array<(received: Received) => void> = [];
  let terminal: Extract<Received, { readonly kind: "close" }> | undefined;
  const deliver = (received: Received) => {
    const waiter = waiting.shift();
    if (waiter === undefined) arrived.push(received);
    else waiter(received);
  };
  socket.addEventListener("message", (event) => {
    deliver(typeof event.data === "string"
      ? { kind: "text", frame: JSON.parse(event.data) as Record<string, unknown> }
      : { kind: "binary", bytes: new Uint8Array(event.data as ArrayBuffer) });
  });
  socket.addEventListener("close", (event) => {
    terminal = { kind: "close", code: event.code };
    for (const waiter of waiting.splice(0)) waiter(terminal);
  });
  const next = () => {
    const ready = arrived.shift() ?? terminal;
    return ready === undefined ? new Promise<Received>((resolve) => waiting.push(resolve)) : Promise.resolve(ready);
  };
  const relay: RelaySocket = {
    send: (frame) => socket.send(frame instanceof Uint8Array ? Uint8Array.from(frame) : JSON.stringify(frame)),
    close: () => socket.close(),
    next,
    until: async (done) => {
      const seen: Received[] = [];
      for (;;) {
        const received = await next();
        seen.push(received);
        if (done(received) || received.kind === "close") return seen;
      }
    },
  };
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(relay), { once: true });
    socket.addEventListener("error", () => reject(new Error("relay socket refused")), { once: true });
  });
}

export function upgradeStatus(base: string, sessionId: string): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(new URL(`/api/v1/voice/speech/ws?sessionId=${encodeURIComponent(sessionId)}`, base), {
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    outgoing.on("upgrade", (incoming, socket) => {
      socket.destroy();
      resolve({ status: incoming.statusCode ?? 0, body: "" });
    });
    outgoing.on("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: incoming.statusCode ?? 0, body: text === "" ? text : (JSON.parse(text) as unknown) });
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}
