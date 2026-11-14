import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Electrobun, { BrowserWindow } from "electrobun/bun";
import { createServer } from "../../server";
import { createBackendRequest } from "./backend-request";

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
        return fetch(createBackendRequest(request, backendUrl));
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
  const backend = createServer({ port: 0, authToken });
  const backendPort = backend.port;
  if (typeof backendPort !== "number") {
    throw new Error("[elizaos-setup] backend did not bind to a TCP port");
  }
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  logEvent("backend.bound", { url: backendUrl, port: backendPort });

  const { url: rendererUrl, port: rendererPort } =
    await startRendererServer(backendUrl);
  logEvent("renderer.bound", { url: rendererUrl, port: rendererPort });

  const preload = `Object.defineProperties(window, {
    __ELIZA_SERVER_URL__: { value: ${JSON.stringify(backendUrl)} },
    __ELIZA_SERVER_TOKEN__: { value: ${JSON.stringify(authToken)} },
  });`;

  const win = new BrowserWindow({
    title: "elizaOS Setup",
    url: `${rendererUrl}/`,
    preload,
    frame: { x: 0, y: 0, width: 1100, height: 760 },
  });

  Electrobun.events.on("will-quit", () => {
    logEvent("application.will_quit");
  });

  // Reference `win` so GC does not collect the window handle.
  void win;
}

void main();
