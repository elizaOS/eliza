/**
 * Supplies a real, page-owned HTTP event stream to browser fixtures. A fulfilled
 * Playwright response ends immediately and therefore cannot model a healthy SSE
 * subscription. This server keeps the socket open and preserves real disconnects.
 */
import { createServer, type ServerResponse } from "node:http";
import type { Page } from "@playwright/test";

export async function installPersistentSseFixture(
  page: Page,
  pattern: string,
  event: string,
  data: unknown,
): Promise<{
  connected: Promise<void>;
  send: (data: unknown) => void;
  disconnect: () => void;
}> {
  const responses = new Set<ServerResponse>();
  const origins = new Set<string>();
  let disconnected = false;
  let ready: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) {
      res.writeHead(403).end();
      return;
    }
    const allowedOrigin = origin ?? [...origins][0];
    if (!allowedOrigin) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    if (disconnected) {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    responses.add(res);
    res.on("close", () => responses.delete(res));
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    ready();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("SSE fixture requires a bound TCP listener");
  }
  const base = `http://127.0.0.1:${address.port}`;
  const disconnect = () => {
    disconnected = true;
    for (const response of responses) response.end();
  };
  page.once("close", () => {
    disconnect();
    server.closeAllConnections();
    server.close();
  });
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const original = new URL(route.request().url());
    origins.add(original.origin);
    await route.continue({
      url: `${base}${original.pathname}${original.search}`,
    });
  });
  return {
    connected,
    send: (next) => {
      if (disconnected)
        throw new Error("Cannot write to a disconnected SSE fixture");
      for (const response of responses)
        response.write(`event: ${event}\ndata: ${JSON.stringify(next)}\n\n`);
    },
    disconnect,
  };
}
