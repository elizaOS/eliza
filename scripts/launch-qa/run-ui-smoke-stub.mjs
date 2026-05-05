#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort } from "../../packages/app/test/utils/get-free-port.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const defaultSpec = "test/ui-smoke/all-pages-clicksafe.spec.ts";
const readyTimeoutMs = 180_000;

function prefixChunk(prefix, chunk) {
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0) {
      process.stdout.write(`${prefix} ${line}\n`);
    }
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForHttp(url, timeoutMs = readyTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}: ${url}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${url}`);
}

async function stopChild(child) {
  if (child.pid == null) return;
  const targetPid = process.platform === "win32" ? child.pid : -child.pid;
  const killTree = (signal) => {
    try {
      process.kill(targetPid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Best effort cleanup.
      }
    }
  };

  killTree("SIGTERM");
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = await Promise.race([
    waitForExit(child).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited && child.exitCode == null && child.signalCode == null) {
    killTree("SIGKILL");
    await waitForExit(child);
  }
}

async function main() {
  const apiPort =
    process.env.ELIZA_UI_SMOKE_API_PORT || String(await getFreePort());
  const uiPort = process.env.ELIZA_UI_SMOKE_PORT || String(await getFreePort());
  const env = {
    ...process.env,
    ELIZA_UI_SMOKE_API_PORT: apiPort,
    ELIZA_UI_SMOKE_FORCE_STUB: "1",
    ELIZA_UI_SMOKE_PORT: uiPort,
    FORCE_COLOR: "0",
  };

  const stack = spawn(
    "node",
    [
      "packages/app-core/scripts/run-node-tsx.mjs",
      "packages/app-core/scripts/playwright-ui-live-stack.ts",
    ],
    {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  stack.stdout.on("data", (chunk) => prefixChunk("[ui-smoke-stack]", chunk));
  stack.stderr.on("data", (chunk) => prefixChunk("[ui-smoke-stack]", chunk));

  let stackExited = false;
  const stackExit = waitForExit(stack).then((result) => {
    stackExited = true;
    return result;
  });

  const shutdown = async (signal) => {
    await stopChild(stack);
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    await Promise.race([
      waitForHttp(`http://127.0.0.1:${uiPort}/chat`),
      stackExit.then(({ code, signal }) => {
        throw new Error(
          `UI smoke stack exited before ready (${signal ?? `code ${code ?? 1}`})`,
        );
      }),
    ]);

    const providedArgs = process.argv.slice(2);
    const hasExplicitSpec = providedArgs.some(
      (arg) => !arg.startsWith("-") && /\.(spec|test)\.[cm]?[tj]sx?$/.test(arg),
    );
    const specArgs = hasExplicitSpec
      ? providedArgs
      : [defaultSpec, ...providedArgs];
    const testEnv = {
      ...env,
      ELIZA_UI_SMOKE_REUSE_SERVER: "1",
    };
    const test = spawn(
      "node",
      [
        "packages/app/scripts/run-ui-playwright.mjs",
        "--config",
        "playwright.ui-smoke.config.ts",
        ...specArgs,
      ],
      {
        cwd: repoRoot,
        env: testEnv,
        stdio: "inherit",
      },
    );

    const heartbeat = setInterval(() => {
      process.stdout.write("[ui-smoke] Playwright still running\n");
    }, 30_000);
    const { code, signal } = await waitForExit(test);
    clearInterval(heartbeat);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  } finally {
    if (!stackExited) {
      await stopChild(stack);
    }
  }
}

main().catch(async (error) => {
  console.error(
    `[ui-smoke] ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exit(1);
});
