import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesRoot = path.resolve(here, "..");
const apiPort = Number(process.env.ELIZA_HOME_API_PORT) || 31337;
const enableAppSourceMaps = process.env.ELIZA_HOME_APP_SOURCEMAP === "1";

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
          "Content-Type, Authorization, X-Api-Key, X-Milady-Token, X-Milady-Export-Token, X-Milady-Client-Id, X-Milady-Terminal-Token, X-Milady-UI-Language",
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
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      // Map capacitor plugins to local plugin source
      {
        find: /^@elizaos\/capacitor-(.*)/,
        replacement: path.resolve(here, "plugins/$1/src/index.ts"),
      },
      // @elizaos/* → sibling packages in the monorepo
      {
        find: /^@elizaos\/autonomous$/,
        replacement: path.resolve(packagesRoot, "autonomous/src/index.ts"),
      },
      {
        find: /^@elizaos\/autonomous\/(.*)$/,
        replacement: path.resolve(packagesRoot, "autonomous/src/$1"),
      },
      {
        find: /^@elizaos\/app-core$/,
        replacement: path.resolve(packagesRoot, "app-core/src/index.ts"),
      },
      {
        find: /^@elizaos\/app-core\/(.*)$/,
        replacement: path.resolve(packagesRoot, "app-core/src/$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.resolve(packagesRoot, "ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.*)$/,
        replacement: path.resolve(packagesRoot, "ui/src/$1"),
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
    port: 2140,
    strictPort: true,
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
