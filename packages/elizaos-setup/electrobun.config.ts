import type { ElectrobunConfig } from "electrobun/bun";

// The Electrobun bun process (src/main/electrobun-main.ts) starts the in-
// process HTTP backend on an ephemeral port, then constructs a BrowserWindow
// whose `preload` script sets `window.__ELIZA_SERVER_URL__` before the
// Vite-built renderer bundle executes.
//
// The renderer's `src/runtime/server-url.ts` reads that global; without the
// preload injection a production build throws on first fetch instead of
// silently falling back to http://127.0.0.1:3743 (which does not exist in a
// packaged build — the Bun server runs in-process on whatever port the main
// process happened to bind to).

export default {
  app: {
    name: "elizaOS Setup",
    identifier: "ai.elizaos.setup",
    version: "1.0.0",
    description:
      "Flash elizaOS AOSP builds onto Pixel devices via ADB and fastboot.",
  },
  build: {
    bun: {
      entrypoint: "src/main/electrobun-main.ts",
      // The bun shell only needs the HTTP server + Electrobun bindings. The
      // renderer is pre-built by Vite and copied into `renderer/` (see
      // `copy` below) — it must not be re-bundled into the bun process.
      external: ["electrobun"],
    },
    views: {},
    copy: {
      // The Vite build (`bun run build`) writes the renderer to `./dist`.
      // Electrobun copies that directory into the packaged app, where the
      // main process loads `renderer/index.html` via a `file://` URL.
      dist: "renderer",
    },
  },
} satisfies ElectrobunConfig;
