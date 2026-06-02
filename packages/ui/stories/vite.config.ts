import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const uiSrc = path.resolve(here, "../src");
const sharedSrc = path.resolve(here, "../../shared/src");
const coreBrowserShim = path.resolve(here, "src/eliza-core-browser-shim.ts");
const loggerSrc = path.resolve(repoRoot, "packages/logger/src/index.ts");

export default defineConfig({
  root: here,
  // Shared UI source reads Node's `process.env` (terminal/theme, globals, etc.)
  // unguarded at module load; shim it to an empty object so those modules can
  // be imported in the browser catalog.
  define: {
    "process.env": "({})",
  },
  plugins: [
    react(),
    {
      // Temporary: the catalog index (`/`) is broken (fs-extra/process), so
      // send the preview to the isolated voice comparison. Remove with the
      // voice.html / voice-main.tsx scaffolding once a variant is chosen.
      name: "voice-compare-root-redirect",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/" || req.url === "/index.html") {
            res.writeHead(302, { Location: "/voice.html" });
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@ui-src": uiSrc,
      "@elizaos/core": coreBrowserShim,
      "@elizaos/logger": loggerSrc,
      "@elizaos/shared": sharedSrc,
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          name: "elizaos-core-browser-entry",
          setup(build) {
            build.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
              path: coreBrowserShim,
            }));
            build.onResolve({ filter: /^@elizaos\/core\/browser$/ }, () => ({
              path: coreBrowserShim,
            }));
            build.onResolve({ filter: /^@elizaos\/logger$/ }, () => ({
              path: loggerSrc,
            }));
          },
        },
      ],
    },
  },
  server: {
    port: 4321,
  },
});
