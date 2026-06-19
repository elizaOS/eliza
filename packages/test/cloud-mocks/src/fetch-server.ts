import http from "node:http";
import { Readable } from "node:stream";

export interface FetchServerOptions {
  port?: number;
  hostname?: string;
}

export interface RunningFetchServer {
  stop(): Promise<void>;
  hostname: string;
  port: number;
}

type BunLikeServer = {
  hostname: string;
  port: number;
  stop(force?: boolean): Promise<void> | void;
};

type BunLike = {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (request: Request) => Response | Promise<Response>;
  }): BunLikeServer;
};

export async function startFetchServer(
  fetch: (request: Request) => Response | Promise<Response>,
  options: FetchServerOptions = {},
): Promise<RunningFetchServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const bun = (globalThis as typeof globalThis & { Bun?: BunLike }).Bun;
  if (bun) {
    const server = bun.serve({
      port: options.port ?? 0,
      hostname,
      fetch,
    });
    const boundHostname = server.hostname;
    const boundPort = server.port;
    if (typeof boundHostname !== "string" || typeof boundPort !== "number") {
      await server.stop(true);
      throw new Error("Mock server did not bind to a host and numeric port");
    }
    return {
      hostname: boundHostname,
      port: boundPort,
      stop: async () => {
        await server.stop(true);
      },
    };
  }

  const server = http.createServer((incoming, outgoing) => {
    void handleNodeRequest(fetch, hostname, incoming, outgoing);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock server did not bind to a numeric port");
  }

  return {
    hostname,
    port: address.port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function handleNodeRequest(
  fetch: (request: Request) => Response | Promise<Response>,
  hostname: string,
  incoming: http.IncomingMessage,
  outgoing: http.ServerResponse,
) {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else if (value !== undefined) {
        headers.set(key, value);
      }
    }

    const host = incoming.headers.host ?? hostname;
    const url = `http://${host}${incoming.url ?? "/"}`;
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const request = new Request(url, {
      method: incoming.method,
      headers,
      body: hasBody ? Readable.toWeb(incoming) : undefined,
      duplex: hasBody ? "half" : undefined,
    } as RequestInit & { duplex?: "half" });

    const response = await fetch(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => {
      outgoing.setHeader(key, value);
    });
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.statusCode = 500;
    outgoing.end(error instanceof Error ? error.message : "mock server error");
  }
}
