#!/usr/bin/env node
/**
 * Development script that starts:
 * 1. The Milaidy API server (port 3001)
 * 2. The Vite UI dev server (port 3000, proxies /api and /ws to 3001)
 *
 * Usage: node scripts/dev-ui.mjs
 */
import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";

const cwd = process.cwd();

// Start the API server (bun handles TypeScript natively)
const apiProcess = spawn(
  "bun",
  ["-e", `
    import { startApiServer } from "./src/api/server.ts";
    startApiServer({ port: 3001 }).then(({ port }) => {
      console.log("[dev] API server ready on port " + port);
    });
  `],
  {
    cwd,
    env: { ...process.env, MILAIDY_PORT: "3001" },
    stdio: "inherit",
  },
);

// Start Vite dev server
const viteProcess = spawn(
  "npx",
  ["vite", "--port", "3000"],
  {
    cwd: path.join(cwd, "apps/ui"),
    env: process.env,
    stdio: "inherit",
  },
);

// Handle cleanup
const cleanup = () => {
  apiProcess.kill();
  viteProcess.kill();
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

apiProcess.on("exit", (code) => {
  if (code !== 0) {
    console.error(`[dev] API server exited with code ${code}`);
    viteProcess.kill();
    process.exit(code ?? 1);
  }
});

viteProcess.on("exit", (code) => {
  if (code !== 0) {
    console.error(`[dev] Vite exited with code ${code}`);
    apiProcess.kill();
    process.exit(code ?? 1);
  }
});
