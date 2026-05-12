#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort } from "../../packages/app/test/utils/get-free-port.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const defaultSpec = "test/ui-smoke/all-pages-clicksafe.spec.ts";
const readyTimeoutMs = 180_000;
const defaultTestGreps = [
  "desktop connectors",
  "mobile connectors",
  "desktop chat",
  "desktop apps catalog",
  "desktop automations",
  "desktop browser",
  "desktop character",
  "desktop character knowledge",
  "desktop wallet",
  "desktop settings",
  "desktop app tool lifeops",
  "desktop app tool tasks",
  "desktop app tool plugins",
  "desktop app tool skills",
  "desktop app tool fine tuning",
  "desktop app tool trajectories",
  "desktop app tool relationships",
  "desktop app tool memories",
  "desktop app tool runtime",
  "desktop app tool database",
  "desktop app tool logs",
  "desktop app tool companion",
  "desktop app tool shopify",
  "desktop app tool vincent",
  "mobile chat",
  "mobile apps catalog",
  "mobile automations",
  "mobile wallet",
  "mobile settings",
  "mobile app tool lifeops",
  "mobile app tool plugins",
  "mobile app tool skills",
  "mobile app tool runtime",
  "mobile app tool logs",
  "visible safe app tiles",
];

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

async function runPlaywright(args, env, label) {
  process.stdout.write(`[ui-smoke] running ${label}\n`);
  const test = spawn(
    "node",
    [
      "packages/app/scripts/run-ui-playwright.mjs",
      "--config",
      "playwright.ui-smoke.config.ts",
      ...args,
    ],
    {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    },
  );

  const heartbeat = setInterval(() => {
    process.stdout.write(`[ui-smoke] ${label} still running\n`);
  }, 10_000);
  const result = await waitForExit(test);
  clearInterval(heartbeat);
  return result;
}

async function runDefaultRouteMatrix() {
  for (const [index, grep] of defaultTestGreps.entries()) {
    process.stdout.write(
      `[ui-smoke] route ${index + 1}/${defaultTestGreps.length}: ${grep}\n`,
    );
    const child = spawn(
      "node",
      ["scripts/launch-qa/run-ui-smoke-stub.mjs", "--grep", grep],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    const { code, signal } = await waitForExit(child);
    if (signal) {
      process.kill(process.pid, signal);
      return false;
    }
    if (code !== 0) {
      process.exitCode = code ?? 1;
      return false;
    }
  }
  return true;
}

async function main() {
  const providedArgs = process.argv.slice(2);
  if (providedArgs.length === 0) {
    process.exitCode = (await runDefaultRouteMatrix())
      ? 0
      : (process.exitCode ?? 1);
    return;
  }

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

    const hasExplicitSpec = providedArgs.some(
      (arg) => !arg.startsWith("-") && /\.(spec|test)\.[cm]?[tj]sx?$/.test(arg),
    );
    const testEnv = {
      ...env,
      ELIZA_UI_SMOKE_REUSE_SERVER: "1",
    };

    const runs = [
      {
        args: hasExplicitSpec ? providedArgs : [defaultSpec, ...providedArgs],
        label: "requested UI smoke",
      },
    ];

    for (const run of runs) {
      const { code, signal } = await runPlaywright(
        run.args,
        testEnv,
        run.label,
      );
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      if (code !== 0) {
        process.exitCode = code ?? 1;
        return;
      }
    }
    process.exitCode = 0;
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
