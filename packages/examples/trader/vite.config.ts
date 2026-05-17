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

const isReactVendor = (id: string): boolean =>
  /node_modules[\\/](?:\.bun[\\/])?(?:react|react-dom|scheduler)/.test(id);

const isElizaRuntimeModule = (id: string): boolean =>
  id.includes("/packages/core/") || id.includes("/packages/plugin-");

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env": {},
    global: "globalThis",
  },
  resolve: {
    alias: nodeBuiltinAliases,
  },
  optimizeDeps: {
    rolldownOptions: {
      transform: {
        define: {
          global: "globalThis",
        },
      },
    },
    exclude: ["@elizaos/plugin-auto-trader"],
  },
  build: {
    chunkSizeWarningLimit: 5500,
    rolldownOptions: {
      external: [
        "technicalindicators",
        "@elizaos/plugin-auto-trader",
        "@elizaos/plugin-trajectory-logger",
      ],
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: isReactVendor,
              priority: 3,
            },
            {
              name: "eliza-runtime",
              test: isElizaRuntimeModule,
              priority: 2,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
