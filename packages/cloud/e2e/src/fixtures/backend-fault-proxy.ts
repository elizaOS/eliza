/**
 * Test-only reverse proxy that can inject a deterministic JSON response before
 * forwarding a frontend request to the real local cloud-api.
 */

import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export interface BackendFault {
  /** Exact URL pathname to fault. Query parameters are ignored. */
  path: string;
  /** Optional HTTP method. When omitted, every method matches. */
  method?: string;
  status: number;
  /** JSON-serializable response body. */
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  delayMs?: number;
  /** Number of matching requests to fault. Omit to fault until clearFault(). */
  times?: number;
}

export interface BackendPathRewrite {
  /** Exact incoming URL pathname. Query parameters are preserved. */
  path: string;
  /** Exact upstream pathname substituted before forwarding. */
  targetPath: string;
  /** Optional HTTP method. When omitted, every method matches. */
  method?: string;
}

export interface RunningBackendFaultProxy {
  url: string;
  port: number;
  setFault(fault: BackendFault): void;
  clearFault(): void;
  /** Route selected HTTP requests to another real endpoint on the same Worker. */
  setPathRewrites(rewrites: readonly BackendPathRewrite[]): void;
  clearPathRewrites(): void;
  /** Number of responses injected for the current/most-recent fault. */
  readonly faultHits: number;
  stop(): Promise<void>;
}

export interface StartBackendFaultProxyOptions {
  targetUrl: string;
  port?: number;
  hostname?: string;
}

interface ActiveFault extends BackendFault {
  method?: string;
  remaining?: number;
  serializedBody?: string;
}

interface ActivePathRewrite extends BackendPathRewrite {
  method?: string;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function assertTestEnvironment(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[backend-fault-proxy] Refusing to start with NODE_ENV=production",
    );
  }
  if (process.env.NODE_ENV === "test" || process.env.CLOUD_E2E === "1") return;
  throw new Error(
    "[backend-fault-proxy] Refusing to start outside NODE_ENV=test/CLOUD_E2E=1",
  );
}

function validateFault(fault: BackendFault): ActiveFault {
  if (!fault.path.startsWith("/")) {
    throw new Error("[backend-fault-proxy] fault.path must start with '/'");
  }
  if (
    !Number.isInteger(fault.status) ||
    fault.status < 100 ||
    fault.status > 599
  ) {
    throw new Error(
      "[backend-fault-proxy] fault.status must be an integer from 100 to 599",
    );
  }
  if (
    fault.delayMs !== undefined &&
    (!Number.isFinite(fault.delayMs) || fault.delayMs < 0)
  ) {
    throw new Error(
      "[backend-fault-proxy] fault.delayMs must be a non-negative number",
    );
  }
  if (
    fault.times !== undefined &&
    (!Number.isInteger(fault.times) || fault.times < 1)
  ) {
    throw new Error(
      "[backend-fault-proxy] fault.times must be a positive integer",
    );
  }

  let serializedBody: string | undefined;
  if (fault.body !== undefined) {
    serializedBody = JSON.stringify(fault.body);
    if (serializedBody === undefined) {
      throw new Error(
        "[backend-fault-proxy] fault.body must be JSON-serializable",
      );
    }
  }

  return {
    ...fault,
    method: fault.method?.toUpperCase(),
    headers: fault.headers ? { ...fault.headers } : undefined,
    remaining: fault.times,
    serializedBody,
  };
}

function requestPathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://backend-fault-proxy.test")
    .pathname;
}

function validatePathRewrites(
  rewrites: readonly BackendPathRewrite[],
): ActivePathRewrite[] {
  return rewrites.map((rewrite) => {
    if (!rewrite.path.startsWith("/") || !rewrite.targetPath.startsWith("/")) {
      throw new Error(
        "[backend-fault-proxy] rewrite paths must start with '/'",
      );
    }
    if (/[?#]/.test(rewrite.targetPath)) {
      throw new Error(
        "[backend-fault-proxy] rewrite.targetPath must not contain a query or hash",
      );
    }
    return {
      ...rewrite,
      method: rewrite.method?.toUpperCase(),
    };
  });
}

function forwardedRequestPath(
  request: IncomingMessage,
  rewrites: readonly ActivePathRewrite[],
): string {
  const incoming = new URL(
    request.url ?? "/",
    "http://backend-fault-proxy.test",
  );
  const method = request.method?.toUpperCase();
  const rewrite = rewrites.find(
    (candidate) =>
      candidate.path === incoming.pathname &&
      (candidate.method === undefined || candidate.method === method),
  );
  return `${rewrite?.targetPath ?? incoming.pathname}${incoming.search}`;
}

function copyForwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded = { ...headers };
  for (const header of HOP_BY_HOP_HEADERS) delete forwarded[header];
  return forwarded;
}

function copyUpstreamHeaders(
  upstream: IncomingMessage,
  response: ServerResponse,
): void {
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue;
    response.setHeader(name, value);
  }
}

function writeFaultResponse(
  request: IncomingMessage,
  response: ServerResponse,
  fault: ActiveFault,
): void {
  const suppliedHeaders = fault.headers ?? {};
  for (const [name, value] of Object.entries(suppliedHeaders)) {
    response.setHeader(name, value);
  }

  const body = fault.serializedBody;
  const hasContentType = Object.keys(suppliedHeaders).some(
    (name) => name.toLowerCase() === "content-type",
  );
  if (body !== undefined && !hasContentType) {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  if (body !== undefined) {
    response.setHeader("Content-Length", Buffer.byteLength(body));
  }

  response.statusCode = fault.status;
  response.end(request.method === "HEAD" ? undefined : body);
}

function forwardHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: URL,
  upstreamRequests: Set<ClientRequest>,
  path: string,
): void {
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path,
      method: request.method,
      headers: copyForwardHeaders(request.headers),
    },
    (upstreamResponse) => {
      response.statusCode = upstreamResponse.statusCode ?? 502;
      if (upstreamResponse.statusMessage) {
        response.statusMessage = upstreamResponse.statusMessage;
      }
      copyUpstreamHeaders(upstreamResponse, response);
      upstreamResponse.pipe(response);
    },
  );
  upstreamRequests.add(upstream);
  upstream.once("close", () => upstreamRequests.delete(upstream));
  upstream.once("error", (error) => {
    if (response.headersSent || response.destroyed) {
      response.destroy(error);
      return;
    }
    const body = JSON.stringify({
      error: "Backend unavailable",
      code: "backend_proxy_error",
    });
    response.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  request.once("aborted", () => upstream.destroy());
  response.once("close", () => {
    if (!response.writableEnded) upstream.destroy();
  });
  request.pipe(upstream);
}

function forwardWebSocket(
  request: IncomingMessage,
  browserSocket: Duplex,
  head: Buffer,
  target: URL,
  sockets: Set<Duplex>,
): void {
  const upstreamSocket = createConnection({
    host: target.hostname,
    port: Number(target.port || 80),
  });
  sockets.add(upstreamSocket);
  upstreamSocket.once("close", () => sockets.delete(upstreamSocket));
  browserSocket.once("close", () => upstreamSocket.destroy());
  upstreamSocket.once("error", () => browserSocket.destroy());
  browserSocket.once("error", () => upstreamSocket.destroy());

  upstreamSocket.once("connect", () => {
    upstreamSocket.write(
      `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n`,
    );
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      upstreamSocket.write(
        `${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`,
      );
    }
    upstreamSocket.write("\r\n");
    if (head.length > 0) upstreamSocket.write(head);
    browserSocket.pipe(upstreamSocket).pipe(browserSocket);
  });
}

/** Start the opt-in fault boundary used only by the Cloud Playwright stack. */
export async function startBackendFaultProxy(
  options: StartBackendFaultProxyOptions,
): Promise<RunningBackendFaultProxy> {
  assertTestEnvironment();
  const target = new URL(options.targetUrl);
  if (target.protocol !== "http:") {
    throw new Error(
      "[backend-fault-proxy] targetUrl must use http for the local E2E stack",
    );
  }

  let activeFault: ActiveFault | undefined;
  let pathRewrites: ActivePathRewrite[] = [];
  let faultHits = 0;
  let stopped = false;
  const stopController = new AbortController();
  const sockets = new Set<Duplex>();
  const upstreamRequests = new Set<ClientRequest>();

  const server = createServer(async (request, response) => {
    const fault = activeFault;
    const matches =
      fault !== undefined &&
      requestPathname(request) === fault.path &&
      (fault.method === undefined ||
        fault.method === request.method?.toUpperCase()) &&
      (fault.remaining === undefined || fault.remaining > 0);

    if (!matches || !fault) {
      forwardHttpRequest(
        request,
        response,
        target,
        upstreamRequests,
        forwardedRequestPath(request, pathRewrites),
      );
      return;
    }

    faultHits += 1;
    if (fault.remaining !== undefined) fault.remaining -= 1;
    request.resume();
    if ((fault.delayMs ?? 0) > 0) {
      try {
        await delay(fault.delayMs, undefined, {
          signal: stopController.signal,
        });
      } catch {
        if (stopController.signal.aborted) return;
        throw new Error("[backend-fault-proxy] fault delay failed");
      }
    }
    if (!response.destroyed) writeFaultResponse(request, response, fault);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    // WebSockets are always transparent. Rewriting `/ws` would fabricate a
    // shared-adapter endpoint that the real Worker deliberately does not own.
    forwardWebSocket(request, socket, head, target, sockets);
  });

  const hostname = options.hostname ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${hostname}:${address.port}`,
    port: address.port,
    setFault(fault) {
      activeFault = validateFault(fault);
      faultHits = 0;
    },
    clearFault() {
      activeFault = undefined;
    },
    setPathRewrites(rewrites) {
      pathRewrites = validatePathRewrites(rewrites);
    },
    clearPathRewrites() {
      pathRewrites = [];
    },
    get faultHits() {
      return faultHits;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      activeFault = undefined;
      pathRewrites = [];
      stopController.abort();
      for (const upstream of upstreamRequests) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
