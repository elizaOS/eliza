import { defineConfig } from "electrobun";

// NOTE: when the Electrobun main process loads the renderer, it MUST inject
// `window.__ELIZA_SERVER_URL__` BEFORE the React bundle executes. Example:
//
//   await webview.executeJavaScript(
//     `window.__ELIZA_SERVER_URL__ = ${JSON.stringify(serverUrl)};`,
//   );
//   await webview.loadURL(rendererUrl);
//
// The `src/runtime/server-url.ts` helper reads that global; without it the
// production build throws on first fetch instead of silently falling back to
// http://localhost:3743 (which doesn't exist in a packaged build — the Bun
// server runs in-process on an unpinned port).

export default defineConfig({
  app: {
    name: "elizaOS Setup",
    identifier: "ai.elizaos.setup",
    version: "1.0.0",
  },
  build: {
    entry: "src/index.ts",
    frontend: {
      root: ".",
      distDir: "dist",
      devCommand: "bun run dev",
      buildCommand: "bun run build",
    },
    output: "build/",
  },
  platforms: {
    macos: {},
    linux: {},
    windows: {},
  },
});
