/**
 * Minimal localhost static server for the walkthrough fixture. The data-driven
 * driver needs a real HTTP origin to drive (a `file://` origin breaks relative
 * navigation and some browser APIs), but the fixture is a single self-contained
 * HTML file — so this serves exactly the files under one directory on an
 * ephemeral port, nothing more. It is not a general web server: only GET, only
 * files inside the served root (traversal is rejected), and it closes cleanly.
 */

import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** A running fixture server: its base URL and a stop() that closes it. */
export interface FixtureServer {
  baseUrl: string;
  stop(): Promise<void>;
}

/**
 * Serve `rootDir` on an ephemeral localhost port. `indexFile` (default
 * `index.html`) answers `/`. Resolves once the port is bound.
 */
export async function serveFixture(
  rootDir: string,
  indexFile = "index.html",
): Promise<FixtureServer> {
  const root = path.resolve(rootDir);
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    } catch {
      // error-policy:J3 untrusted request input — malformed percent-encoding
      // (e.g. GET /%) is a 400 response, never an uncaught URIError that kills
      // the server mid-walkthrough.
      res.writeHead(400).end("bad request");
      return;
    }
    const rel = urlPath === "/" ? indexFile : urlPath.replace(/^\/+/, "");
    const filePath = path.resolve(root, rel);
    // Traversal guard: a resolved path must stay inside the served root.
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      // error-policy:J1 request boundary — a missing file is a 404 response,
      // the correct HTTP outcome, not a swallowed error.
      res.writeHead(404).end("not found");
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const type =
      CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
      "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    createReadStream(filePath).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
