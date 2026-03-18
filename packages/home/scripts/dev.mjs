#!/usr/bin/env node
/**
 * Combined dev server script for packages/home.
 *
 * Starts both:
 *   1. The autonomous backend (port 4001)
 *   2. The Vite frontend dev server (port 4000)
 *
 * All backend logs stream to stdout so they're visible in the terminal
 * without needing to set any env vars.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const homeRoot = path.resolve(here, "..");
const autonomousRoot = path.resolve(homeRoot, "..", "autonomous");

const BACKEND_PORT = process.env.ELIZA_HOME_API_PORT || "4001";
const FRONTEND_PORT = process.env.ELIZA_HOME_PORT || "4000";

const children = [];

function killAll() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

process.on("SIGINT", () => {
  killAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killAll();
  process.exit(0);
});

// ── 1. Start autonomous backend ──────────────────────────────────────────────
console.log(
  `[home-dev] Starting autonomous backend on port ${BACKEND_PORT}...`,
);

const backend = spawn(
  "node",
  ["--import", "tsx", path.join(autonomousRoot, "src", "bin.ts"), "serve"],
  {
    cwd: autonomousRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELIZA_PORT: BACKEND_PORT,
      LOG_LEVEL: process.env.LOG_LEVEL || "info",
    },
  },
);
children.push(backend);

backend.stdout.on("data", (chunk) => {
  process.stdout.write(`[backend] ${chunk}`);
});
backend.stderr.on("data", (chunk) => {
  process.stderr.write(`[backend] ${chunk}`);
});
backend.on("exit", (code) => {
  console.error(`[home-dev] Backend exited with code ${code}`);
  killAll();
  process.exit(code ?? 1);
});

// ── 2. Start Vite frontend ──────────────────────────────────────────────────
console.log(`[home-dev] Starting Vite frontend on port ${FRONTEND_PORT}...`);

const frontend = spawn("npx", ["vite", "--port", FRONTEND_PORT], {
  cwd: homeRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    ELIZA_HOME_API_PORT: BACKEND_PORT,
  },
});
children.push(frontend);

frontend.stdout.on("data", (chunk) => {
  process.stdout.write(`${chunk}`);
});
frontend.stderr.on("data", (chunk) => {
  process.stderr.write(`${chunk}`);
});
frontend.on("exit", (code) => {
  console.error(`[home-dev] Vite exited with code ${code}`);
  killAll();
  process.exit(code ?? 1);
});
