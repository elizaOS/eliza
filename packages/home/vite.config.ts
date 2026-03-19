import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesRoot = path.resolve(here, "..");
const apiPort = Number(process.env.ELIZA_HOME_API_PORT) || 4001;
const enableAppSourceMaps = process.env.ELIZA_HOME_APP_SOURCEMAP === "1";

/**
 * Dev-only middleware that gates /api requests on backend availability.
 * When the backend isn't listening yet, returns 503 immediately so the
 * request never reaches Vite's proxy (which would log noisy ECONNREFUSED
 * errors).  Once the backend is reachable the gate opens and stays open.
 */
function apiGatePlugin(): Plugin {
  let backendUp = false;

  function probeBackend(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = createConnection({ port: apiPort, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => {
        sock.destroy();
        resolve(false);
      });
      // Don't let the probe hang; give it 200 ms.
      sock.setTimeout(200, () => {
        sock.destroy();
        resolve(false);
      });
    });
  }

  return {
    name: "api-gate",
    configureServer(server) {
      // Add middleware directly (not returned) so it runs BEFORE the proxy.
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api") && !req.url?.startsWith("/ws")) {
          return next();
        }

        // Fast path: once the backend is confirmed up, skip probing.
        if (backendUp) return next();

        probeBackend().then((up) => {
          if (up) {
            backendUp = true;
            return next();
          }
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "API server not ready" }));
        });
      });
    },
  };
}

/**
 * Dev-only middleware that handles CORS for Electron's custom-scheme origin
 * (capacitor-electron://-). Vite's proxy doesn't reliably forward CORS headers
 * for non-http origins, so we intercept preflight OPTIONS requests and tag
 * every /api response with the correct headers before the proxy layer.
 */
function electronCorsPlugin(): Plugin {
  return {
    name: "electron-cors",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const origin = req.headers.origin;
        if (!origin || !req.url?.startsWith("/api")) return next();

        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, DELETE, OPTIONS",
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Api-Key, X-Eliza-Token, X-Eliza-Export-Token, X-Eliza-Client-Id, X-Eliza-Terminal-Token, X-Eliza-UI-Language",
        );

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.end();
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  root: here,
  base: "./",
  publicDir: path.resolve(here, "public"),
  plugins: [
    tailwindcss(),
    react(),
    electronCorsPlugin(),
    apiGatePlugin(),
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      // Map capacitor plugins to local plugin source
      {
        find: /^@elizaos\/capacitor-(.*)/,
        replacement: path.resolve(here, "plugins/$1/src/index.ts"),
      },
      // @elizaos/* → sibling packages in the monorepo (built dist)
      {
        find: /^@elizaos\/autonomous$/,
        replacement: path.resolve(packagesRoot, "autonomous/dist/packages/autonomous/src/index.js"),
      },
      {
        find: /^@elizaos\/autonomous\/(.*)$/,
        replacement: path.resolve(packagesRoot, "autonomous/dist/packages/autonomous/src/$1"),
      },
      {
        find: /^@elizaos\/app-core$/,
        replacement: path.resolve(packagesRoot, "app-core/dist/index.js"),
      },
      {
        find: /^@elizaos\/app-core\/(.*)$/,
        replacement: path.resolve(packagesRoot, "app-core/dist/$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.resolve(packagesRoot, "ui/dist/index.js"),
      },
      {
        find: /^@elizaos\/ui\/(.*)$/,
        replacement: path.resolve(packagesRoot, "ui/dist/$1"),
      },
    ],
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
    sourcemap: enableAppSourceMaps,
    target: "es2022",
    rollupOptions: {
      input: {
        main: path.resolve(here, "index.html"),
      },
    },
    commonjsOptions: {
      include: [/node_modules/],
    },
  },
  server: {
    host: true,
    port: 4000,
    strictPort: false,
    cors: {
      origin: true,
      credentials: true,
    },
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
    fs: {
      allow: [here, packagesRoot, path.resolve(here, "../..")],
    },
    watch: {
      usePolling: process.env.ELIZA_HOME_DEV_POLLING === "1",
    },
  },
});
