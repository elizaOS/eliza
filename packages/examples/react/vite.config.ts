import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const nodeStub = fileURLToPath(
  new URL("./src/stubs/node-builtins.ts", import.meta.url),
);

const nodeBuiltinIds = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "constants",
  "crypto",
  "dns/promises",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "stream",
  "tls",
  "url",
  "util",
  "vm",
  "zlib",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const nodeBuiltinAliases = [
  ...nodeBuiltinIds.flatMap((id) => {
    const escaped = escapeRegExp(id);
    return [
      { find: new RegExp(`^${escaped}$`), replacement: nodeStub },
      { find: new RegExp(`^node:${escaped}$`), replacement: nodeStub },
    ];
  }),
  ...["fs-extra", "graceful-fs", "jsonfile"].map((id) => ({
    find: new RegExp(`^${escapeRegExp(id)}$`),
    replacement: nodeStub,
  })),
];

function isPgliteEvalWarning(log: {
  code?: string;
  id?: string;
  message?: string;
}) {
  const source = `${log.id ?? ""} ${log.message ?? ""}`;
  return log.code === "EVAL" && source.includes("@electric-sql/pglite");
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    headers: {
      // Required for SharedArrayBuffer used by PGlite
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // Allow serving files from node_modules for PGlite WASM assets
      allow: ["../.."],
    },
  },
  define: {
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    conditions: ["browser", "import", "module", "default"],
    alias: nodeBuiltinAliases,
  },
  optimizeDeps: {
    // Exclude PGlite from pre-bundling - it handles its own WASM loading
    exclude: ["@electric-sql/pglite"],
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 7500,
    modulePreload: {
      polyfill: true,
    },
    rolldownOptions: {
      onLog(level, log, defaultHandler) {
        if (isPgliteEvalWarning(log)) return;
        defaultHandler(level, log);
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:\.bun[\\/])?(?:react|react-dom|scheduler)/,
              priority: 4,
            },
            {
              name: "pglite",
              test: (id) =>
                id.includes("@electric-sql/pglite") ||
                id.endsWith("/src/pglite-browser.ts"),
              priority: 3,
            },
            {
              name: "eliza-runtime",
              test: (id) =>
                id.includes("/packages/core/") ||
                id.includes("/packages/plugin-"),
              priority: 2,
            },
          ],
        },
      },
    },
  },
});
