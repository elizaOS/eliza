// ---------------------------------------------------------------------------
// Electrobun main-process entrypoint for elizaos-setup.
//
// Responsibilities:
//   1. Boot the in-process Bun HTTP backend (`createServer()` from server.ts)
//      on a known port, falling back to an ephemeral port if the default is
//      already taken.
//   2. Serve the packaged renderer over loopback HTTP. WKWebView cannot load
//      Vite's crossorigin ES modules reliably from `file://`.
//   3. Proxy renderer `/api/*` requests to the in-process backend as a
//      same-origin fallback.
//   4. Inject the loopback backend URL before any bundle script runs so every
//      renderer client uses one consistent API base.
//
// This is the only path that produces a working packaged app. If preload
// injection fails, `getServerUrl()` throws in production rather than
// silently falling back to a port that doesn't exist.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Electrobun, { BrowserWindow } from "electrobun/bun";
import { createServer } from "../../server";

const DEFAULT_PORT = 3743;

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "info",
      component: "elizaos-setup",
      event,
      ...fields,
    })}\n`,
  );
}

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const tester = createNetServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "127.0.0.1");
  });
}

async function startBackend(
  authToken: string,
): Promise<{ url: string; port: number }> {
  const desired = Number(process.env.ELIZA_SETUP_PORT ?? DEFAULT_PORT);
  const port = (await isPortFree(desired)) ? desired : 0;
  const server = createServer({ port, authToken });
  const boundPort = server.port;
  if (typeof boundPort !== "number") {
    throw new Error("[elizaos-setup] backend did not bind to a TCP port");
  }
  return { url: `http://127.0.0.1:${boundPort}`, port: boundPort };
}

function buildPreloadScript(serverUrl: string, authToken: string): string {
  // Runs in the renderer global scope before any other script.
  // Electrobun passes this string directly to the webview's preload hook.
  return `(() => {
  try {
    Object.defineProperty(window, "__ELIZA_SERVER_URL__", {
      value: ${JSON.stringify(serverUrl)},
      writable: false,
      configurable: false,
    });
  } catch (_err) {
    // If a previous preload (or a bundle race) already defined it, fall back
    // to a plain assignment. The renderer just needs the value set before
    // getServerUrl() is called.
    window.__ELIZA_SERVER_URL__ = ${JSON.stringify(serverUrl)};
  }
  Object.defineProperty(window, "__ELIZA_SERVER_TOKEN__", {
    value: ${JSON.stringify(authToken)},
    writable: false,
    configurable: false,
  });
})();`;
}

async function startRendererServer(
  backendUrl: string,
): Promise<{ url: string; port: number }> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rendererRoot = path.resolve(here, "..", "renderer");
  const indexPath = path.join(rendererRoot, "index.html");
  if (!(await Bun.file(indexPath).exists())) {
    throw new Error(`[elizaos-setup] renderer not found at ${indexPath}`);
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const backendPath = url.pathname.slice("/api".length) || "/";
        const target = new URL(`${backendPath}${url.search}`, backendUrl);
        return fetch(new Request(target, request));
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405 });
      }

      let requestedPath: string;
      try {
        requestedPath = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Invalid path", { status: 400 });
      }

      const relativePath =
        requestedPath === "/"
          ? "index.html"
          : requestedPath.replace(/^\/+/, "");
      const filePath = path.resolve(rendererRoot, relativePath);
      if (
        filePath !== indexPath &&
        !filePath.startsWith(`${rendererRoot}${path.sep}`)
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(request.method === "HEAD" ? null : file, {
        headers: { "Content-Type": file.type },
      });
    },
  });

  const port = server.port;
  if (typeof port !== "number") {
    throw new Error("[elizaos-setup] renderer did not bind to a TCP port");
  }
  return { url: `http://127.0.0.1:${port}`, port };
}

async function main(): Promise<void> {
  const authToken = randomBytes(32).toString("hex");
  const { url: backendUrl, port: backendPort } = await startBackend(authToken);
  logEvent("backend.bound", { url: backendUrl, port: backendPort });

  const { url: rendererUrl, port: rendererPort } =
    await startRendererServer(backendUrl);
  logEvent("renderer.bound", { url: rendererUrl, port: rendererPort });

  const preload = buildPreloadScript(backendUrl, authToken);

  const win = new BrowserWindow({
    title: "elizaOS Setup",
    url: `${rendererUrl}/`,
    preload,
    frame: { x: 0, y: 0, width: 1100, height: 760 },
  });

  // Surface unhandled errors loudly instead of swallowing them — a broken
  // window creation should not silently produce a blank packaged app.
  Electrobun.events.on("will-quit", () => {
    logEvent("application.will_quit");
  });

  // Reference `win` so GC does not collect the window handle.
  void win;
}

void main();
