/** Real Node loopback servers for HTTP streaming and WebSocket transport tests. */
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";

export type LoopbackWebSocket = WebSocket;
type RequestHandler = (request: Request) => Response | Promise<Response>;

function webRequest(
  request: IncomingMessage,
  signal?: AbortSignal,
  body?: Uint8Array<ArrayBuffer>,
) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    for (const item of Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value]) {
      headers.append(name, item);
    }
  }
  return new Request(`http://${request.headers.host}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers,
    ...(signal ? { signal } : {}),
    ...(body?.length ? { body } : {}),
  });
}

export async function listenLoopbackHttp(handler: RequestHandler) {
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => controller.abort();
    const closed = () => {
      if (!response.writableFinished) {
        controller.abort();
        void reader?.cancel().catch(() => {});
      }
    };
    request.once("aborted", abort);
    response.once("close", closed);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await handler(
        webRequest(
          request,
          controller.signal,
          new Uint8Array(Buffer.concat(chunks)),
        ),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.flushHeaders();
      reader = result.body?.getReader();
      if (reader) {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done || response.destroyed) break;
          if (!response.write(chunk.value))
            await once(response, "drain", { signal: controller.signal });
        }
      }
      if (!response.destroyed) response.end();
    } catch (error) {
      if (!controller.signal.aborted) errors.push(error);
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", closed);
      await reader?.cancel().catch(() => {});
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing loopback server address");
  let closing: Promise<void> | undefined;
  return {
    server,
    url: new URL(`http://127.0.0.1:${address.port}`),
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else if (errors.length) reject(errors[0]);
          else resolve();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

export async function listenLoopbackWebSocket(
  handler: RequestHandler,
  acceptsUpgrade: (request: Request) => boolean,
) {
  const http = await listenLoopbackHttp(handler);
  const sockets = new WebSocketServer({ noServer: true });
  http.server.on("upgrade", (request, socket, head) => {
    if (!acceptsUpgrade(webRequest(request))) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) =>
      sockets.emit("connection", client, request),
    );
  });
  let closing: Promise<void> | undefined;
  return {
    url: http.url,
    sockets,
    close() {
      closing ??= Promise.all([
        new Promise<void>((resolve, reject) => {
          for (const client of sockets.clients) client.terminate();
          sockets.close((error) => (error ? reject(error) : resolve()));
        }),
        http.close(),
      ]).then(() => {});
      return closing;
    },
  };
}
