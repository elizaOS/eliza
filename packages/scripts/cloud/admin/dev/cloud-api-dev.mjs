#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const args = process.argv.slice(2);
const host = process.env.PGLITE_HOST || "127.0.0.1";
const port = Number.parseInt(
  process.env.DEV_CLOUD_PGLITE_PORT || process.env.PGLITE_PORT || "55432",
  10,
);
const apiPort = process.env.API_DEV_PORT || "8787";
const maxConnections = process.env.PGLITE_MAX_CONNECTIONS || "16";
const startupTimeoutMs = Number.parseInt(
  process.env.DEV_CLOUD_STARTUP_TIMEOUT_MS || "120000",
  10,
);
const pollIntervalMs = 500;

function bunExecutable() {
  if (process.env.BUN && existsSync(process.env.BUN)) return process.env.BUN;
  const homeBun = path.resolve(process.env.HOME || "", ".bun/bin/bun");
  if (existsSync(homeBun)) return homeBun;
  const pathBun = process.env.PATH?.split(path.delimiter)
    .map((entry) => path.resolve(entry, "bun"))
    .find((candidate) => existsSync(candidate));
  if (pathBun) return pathBun;
  if (process.env.npm_execpath?.includes("bun"))
    return process.env.npm_execpath;
  return "bun";
}

function parsePGliteDataDir(url) {
  if (!url?.startsWith("pglite://")) return null;
  const dataDir = url.slice("pglite://".length);
  if (!dataDir || dataDir === "memory") return null;
  return dataDir;
}

function shouldUsePGliteTcpBridge(env) {
  const url = env.DATABASE_URL || env.TEST_DATABASE_URL || "";
  return !url || url.startsWith("pglite://");
}

async function tcpOk() {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForTcp(child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < startupTimeoutMs) {
    if (await tcpOk()) return;
    if (child.exitCode !== null) {
      throw new Error(`PGlite TCP server exited with code ${child.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(
    `PGlite TCP server did not become reachable at ${host}:${port}`,
  );
}

function runStep(label, command, stepArgs, env) {
  const result = spawnSync(command, stepArgs, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status}`);
  }
}

async function main() {
  const bun = bunExecutable();
  let pgliteChild = null;
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "development",
    API_DEV_PORT: apiPort,
  };

  if (shouldUsePGliteTcpBridge(env)) {
    const configuredUrl = env.DATABASE_URL || env.TEST_DATABASE_URL || "";
    const dataDir =
      parsePGliteDataDir(configuredUrl) ||
      env.DEV_CLOUD_PGLITE_DATA_DIR ||
      env.PGLITE_DATA_DIR ||
      ".eliza/.pgdata";
    env.DATABASE_URL = `postgresql://postgres@${host}:${port}/postgres`;
    env.TEST_DATABASE_URL ||= env.DATABASE_URL;

    if (!(await tcpOk())) {
      pgliteChild = spawn(
        bun,
        ["run", "packages/scripts/cloud/admin/dev/pglite-server.ts"],
        {
          cwd: repoRoot,
          env: {
            ...env,
            PGLITE_HOST: host,
            PGLITE_PORT: String(port),
            PGLITE_MAX_CONNECTIONS: maxConnections,
            PGLITE_DATA_DIR: dataDir,
          },
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
      await waitForTcp(pgliteChild);
    }
  }

  if (env.DEV_CLOUD_SKIP_MIGRATE !== "1") {
    runStep("db:cloud:migrate", bun, ["run", "db:cloud:migrate"], env);
  }

  runStep(
    "sync-api-dev-vars",
    bun,
    ["run", "packages/scripts/cloud/admin/sync-api-dev-vars.ts"],
    env,
  );

  const wranglerArgs =
    args.length > 0 ? args : ["dev", "--port", apiPort, "--local"];

  const wrangler = spawn(bun, ["run", "wrangler", ...wranglerArgs], {
    cwd: path.join(repoRoot, "packages", "cloud-api"),
    env,
    stdio: "inherit",
  });

  const shutdown = () => {
    wrangler.kill("SIGTERM");
    pgliteChild?.kill("SIGTERM");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  wrangler.on("exit", (code, signal) => {
    pgliteChild?.kill("SIGTERM");
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
