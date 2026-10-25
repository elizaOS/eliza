/**
 * Owns TCP listener binding, dynamic-port fallback, and socket shutdown for the
 * agent API. The composition root supplies logging and resource teardown so
 * this transport boundary remains independent of agent features.
 */
import type { Server } from "node:http";

export interface HttpListener {
  port: number;
  close(): Promise<void>;
}

export interface ListenHttpServerOptions {
  server: Server;
  host: string;
  port: number;
  strictPortBinding: boolean;
  closeResources(): Promise<void>;
  onBeforeListen?(): void;
  onPortInUse?(port: number, willFallback: boolean): void;
  onListening?(host: string, port: number): void;
  onServerError?(error: NodeJS.ErrnoException): void;
  onCloseHelperError?(helper: string, error: unknown): void;
}

async function closeSocketServer(
  server: Server,
  reportHelperError: (helper: string, error: unknown) => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const timeout = setTimeout(resolveOnce, 5_000);
    function resolveOnce(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    }

    for (const helper of [
      "closeAllConnections",
      "closeIdleConnections",
    ] as const) {
      const closeConnections = server[helper];
      if (typeof closeConnections !== "function") continue;
      try {
        closeConnections.call(server);
      } catch (error) {
        // error-policy:J6 Node and Bun expose these optional helpers with
        // runtime-specific behavior; the normal server close still proceeds.
        reportHelperError(helper, error);
      }
    }
    server.close(resolveOnce);
  });
}

export function listenHttpServer(
  options: ListenHttpServerOptions,
): Promise<HttpListener> {
  return new Promise((resolve, reject) => {
    let requestedPort = options.port;
    let settled = false;

    const fail = (error: NodeJS.ErrnoException): void => {
      options.onServerError?.(error);
      void options.closeResources().finally(() => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    };

    options.server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        const willFallback = requestedPort !== 0 && !options.strictPortBinding;
        options.onPortInUse?.(requestedPort, willFallback);
        if (willFallback) {
          requestedPort = 0;
          setImmediate(() => options.server.listen(0, options.host));
          return;
        }
      }
      fail(error);
    });

    options.server.once("listening", () => {
      const address = options.server.address();
      const actualPort =
        typeof address === "object" && address ? address.port : requestedPort;
      const actualHost =
        typeof address === "object" && address ? address.address : options.host;
      options.onListening?.(actualHost, actualPort);
      if (settled) return;
      settled = true;
      resolve({
        port: actualPort,
        close: async () => {
          await Promise.all([
            options.closeResources(),
            closeSocketServer(options.server, (helper, error) =>
              options.onCloseHelperError?.(helper, error),
            ),
          ]);
        },
      });
    });
    options.onBeforeListen?.();
    options.server.listen(options.port, options.host);
  });
}
