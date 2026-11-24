// spec/core/models.md, "Story: Dispatch a complete admitted request"; spec/core/voice.md, "Story: Interrupt one voice turn across its consumers"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One request the server saw, and whether its connection has since closed. */
export interface Seen {
  readonly path: string;
  closed: boolean;
}

/** A plain HTTP server on 127.0.0.1 that a model transport reaches; `close` ends every connection still open. */
export interface Loopback {
  readonly port: number;
  readonly requests: Seen[];
  url(host: string, pathname?: string): string;
  socketClosed(index: number): Promise<void>;
  close(): Promise<void>;
}

export async function loopback(respond: (request: IncomingMessage, response: ServerResponse) => void): Promise<Loopback> {
  const requests: Seen[] = [];
  const ended: Promise<void>[] = [];
  const open = new Set<Socket>();
  const server = createServer((request, response) => {
    const seen: Seen = { path: request.url ?? "", closed: false };
    requests.push(seen);
    ended.push(new Promise<void>((settle) => request.socket.once("close", () => { seen.closed = true; settle(); })));
    respond(request, response);
  });
  server.on("connection", (socket: Socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return {
    port,
    requests,
    url: (host, pathname = "/") => `http://${host}:${port}${pathname}`,
    socketClosed: (index) => ended[index] ?? Promise.reject(new Error(`loopback: request ${index} never arrived`)),
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of open) socket.destroy();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
