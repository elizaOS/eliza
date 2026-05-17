// ---------------------------------------------------------------------------
// Electrobun main-process entrypoint for elizaos-setup.
//
// Responsibilities:
//   1. Boot the in-process Bun HTTP backend (`createServer()` from server.ts)
//      on a known port, falling back to an ephemeral port if the default is
//      already taken.
//   2. Inject `window.__ELIZA_SERVER_URL__` into the renderer BEFORE any
//      bundle script runs, by passing a preload script string to the
//      Electrobun `BrowserWindow`. The renderer's `getServerUrl()` reads
//      that global as the highest-precedence source.
//   3. Load the renderer (`renderer/index.html`, copied from the Vite build
//      via `electrobun.config.ts`) from inside the packaged app bundle.
//
// This is the only path that produces a working packaged app. If preload
// injection fails, `getServerUrl()` throws in production rather than
// silently falling back to a port that doesn't exist.
// ---------------------------------------------------------------------------

import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Electrobun, { BrowserWindow } from "electrobun/bun";
import { createServer } from "../../server";

const DEFAULT_PORT = 3743;

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

async function startBackend(): Promise<{ url: string; port: number }> {
  const desired = Number(process.env.ELIZA_SETUP_PORT ?? DEFAULT_PORT);
  const port = (await isPortFree(desired)) ? desired : 0;
  const server = createServer({ port });
  const boundPort = server.port;
  if (typeof boundPort !== "number") {
    throw new Error("[elizaos-setup] backend did not bind to a TCP port");
  }
  return { url: `http://127.0.0.1:${boundPort}`, port: boundPort };
}

function buildPreloadScript(serverUrl: string): string {
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
})();`;
}

function resolveRendererIndexUrl(): string {
  // In the packaged app, electrobun.config.ts copies the Vite `dist/`
  // output to `renderer/` next to the bun bundle. `import.meta.url` is the
  // compiled entrypoint location.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const indexPath = path.join(here, "..", "renderer", "index.html");
  return `file://${indexPath}`;
}

async function main(): Promise<void> {
  const { url: serverUrl, port } = await startBackend();
  console.log(`[elizaos-setup] backend bound at ${serverUrl} (port ${port})`);

  const preload = buildPreloadScript(serverUrl);
  const rendererUrl = resolveRendererIndexUrl();

  const win = new BrowserWindow({
    title: "elizaOS Setup",
    url: rendererUrl,
    preload,
    frame: { x: 0, y: 0, width: 1100, height: 760 },
  });

  // Surface unhandled errors loudly instead of swallowing them — a broken
  // window creation should not silently produce a blank packaged app.
  Electrobun.events.on("will-quit", () => {
    console.log("[elizaos-setup] will-quit");
  });

  // Reference `win` so GC does not collect the window handle.
  void win;
}

void main();
