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
import { createConnection } from "node:net";
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
      // Use the small embedding model by default so the first run doesn't
      // block on a multi-GB download.  Override with env vars if desired.
      LOCAL_EMBEDDING_MODEL:
        process.env.LOCAL_EMBEDDING_MODEL || "nomic-embed-text-v1.5.Q5_K_M.gguf",
      LOCAL_EMBEDDING_MODEL_REPO:
        process.env.LOCAL_EMBEDDING_MODEL_REPO || "nomic-ai/nomic-embed-text-v1.5-GGUF",
      LOCAL_EMBEDDING_DIMENSIONS:
        process.env.LOCAL_EMBEDDING_DIMENSIONS || "768",
      LOCAL_EMBEDDING_CONTEXT_SIZE:
        process.env.LOCAL_EMBEDDING_CONTEXT_SIZE || "8192",
      LOCAL_EMBEDDING_GPU_LAYERS:
        process.env.LOCAL_EMBEDDING_GPU_LAYERS || "auto",
      LOCAL_EMBEDDING_USE_MMAP:
        process.env.LOCAL_EMBEDDING_USE_MMAP || "false",
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
});

// ── 2. Wait for backend to be listening, then start Vite frontend ───────────

/** Poll until a TCP connection to `port` succeeds (or `timeoutMs` elapses). */
function waitForPort(port, { intervalMs = 500, timeoutMs = 120_000 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const sock = createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Backend did not start within ${timeoutMs / 1000}s`));
        } else {
          setTimeout(attempt, intervalMs);
        }
      });
    }
    attempt();
  });
}

console.log(`[home-dev] Waiting for backend on port ${BACKEND_PORT}...`);

// Race: wait for the port to open OR for the backend process to exit.
const backendExited = new Promise((resolve) => {
  backend.on("exit", (code) => resolve(code));
});
const portOrExit = await Promise.race([
  waitForPort(Number(BACKEND_PORT)).then(() => "ready"),
  backendExited.then((code) => `exited:${code}`),
]);

if (typeof portOrExit === "string" && portOrExit.startsWith("exited:")) {
  console.warn(
    `[home-dev] Backend exited before listening (${portOrExit}). Starting Vite anyway...`,
  );
} else {
  console.log(
    `[home-dev] Backend is listening. Starting Vite frontend on port ${FRONTEND_PORT}...`,
  );
}

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
