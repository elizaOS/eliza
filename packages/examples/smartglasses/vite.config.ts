import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/core": new URL("./core-browser-shim.ts", import.meta.url)
        .pathname,
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5178,
  },
});
