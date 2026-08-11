import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served same-origin by @elizaos/agent under /trust-check/ (see
// packages/agent/src/api/server.ts's serveSkunkScanWeb) - base must match
// that mount path so built asset URLs resolve correctly.
export default defineConfig({
  base: "/trust-check/",
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  server: {
    port: 4466,
    // Dev-only convenience: proxies API calls to a locally running agent
    // process so `bun run dev` here works without CORS setup. Adjust the
    // target if your local agent binds a different port. Not used in
    // production - there this page is served same-origin by the agent
    // itself (see server.ts's serveSkunkScanWeb), so no proxy is involved.
    proxy: {
      "/api/skunkscan": "http://localhost:3000",
    },
  },
});
