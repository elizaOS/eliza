import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { config } from "dotenv";

for (const envPath of [resolve(".env"), resolve(".env.local"), resolve(".env.test")]) {
  config({ path: envPath });
}

const port = Number.parseInt(process.env.TEST_API_PORT || "8787", 10);
const baseUrl = process.env.TEST_API_BASE_URL || `http://127.0.0.1:${port}`;
const startupTimeoutMs = 120_000;
const pollIntervalMs = 500;
const testAuthSecret = process.env.PLAYWRIGHT_TEST_AUTH_SECRET || "playwright-local-auth-secret";
const pglitePort = Number.parseInt(process.env.TEST_PGLITE_PORT || "55432", 10);
const pgliteHost = process.env.PGLITE_HOST || "127.0.0.1";
const pgliteDataDir = process.env.TEST_PGLITE_DATA_DIR || ".eliza/.pgdata-worker-e2e";
const pgliteMaxConnections =
  process.env.TEST_PGLITE_MAX_CONNECTIONS || process.env.PGLITE_MAX_CONNECTIONS || "16";
const defaultE2eEnv = {
  CRON_SECRET: process.env.CRON_SECRET || "test-cron-secret",
  INTERNAL_SECRET: process.env.INTERNAL_SECRET || "test-internal-secret",
  AGENT_TEST_BOOTSTRAP_ADMIN: process.env.AGENT_TEST_BOOTSTRAP_ADMIN || "true",
  PLAYWRIGHT_TEST_AUTH: process.env.PLAYWRIGHT_TEST_AUTH || "true",
  PLAYWRIGHT_TEST_AUTH_SECRET: testAuthSecret,
};

function bunExecutable() {
  return process.env.BUN || process.env.npm_execpath || process.execPath || "bun";
}

function parsePGliteDataDir(url) {
  if (!url?.startsWith("pglite://")) return null;
  const dataDir = url.slice("pglite://".length);
  if (!dataDir || dataDir === "memory") return null;
  return dataDir;
}

async function tcpOk(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1_000);
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

async function healthOk() {
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForTcp(child, host, port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < startupTimeoutMs) {
    if (await tcpOk(host, port)) return;
    if (child.exitCode !== null) {
      throw new Error(`PGlite TCP server exited with code ${child.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`PGlite TCP server did not become reachable at ${host}:${port}`);
}

async function waitForHealth(child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < startupTimeoutMs) {
    if (await healthOk()) return;
    if (child.exitCode !== null) {
      throw new Error(`Worker dev server exited with code ${child.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Worker dev server did not become healthy at ${baseUrl}/api/health`);
}

async function main() {
  const bun = bunExecutable();
  let child = null;
  let pgliteChild = null;
  const testEnv = {
    ...process.env,
    ...defaultE2eEnv,
  };
  if (!testEnv.TEST_DATABASE_URL && testEnv.DATABASE_URL) {
    console.warn(
      "[worker-e2e] Ignoring DATABASE_URL for Worker e2e. Set TEST_DATABASE_URL to run against an explicit test database.",
    );
    delete testEnv.DATABASE_URL;
  }

  const configuredDbUrl = testEnv.TEST_DATABASE_URL || "";
  const usingPGliteTcpBridge = !configuredDbUrl || configuredDbUrl.startsWith("pglite://");
  let workerExit = null;
  let result;

  try {
    if (usingPGliteTcpBridge) {
      const pgliteDatabaseUrl = `postgresql://postgres@${pgliteHost}:${pglitePort}/postgres`;
      const dataDir = parsePGliteDataDir(configuredDbUrl) || pgliteDataDir;
      const shouldResetDefaultPGlite =
        !configuredDbUrl && testEnv.TEST_PGLITE_PERSIST !== "1" && Boolean(dataDir);
      testEnv.DATABASE_URL = pgliteDatabaseUrl;
      testEnv.TEST_DATABASE_URL = pgliteDatabaseUrl;

      const pgliteAlreadyRunning = await tcpOk(pgliteHost, pglitePort);
      if (shouldResetDefaultPGlite) {
        if (pgliteAlreadyRunning) {
          throw new Error(
            `Default Worker e2e PGlite server is already running at ${pgliteHost}:${pglitePort}; stop it before running isolated tests, or set TEST_PGLITE_PERSIST=1 to reuse it.`,
          );
        }
        rmSync(resolve(dataDir), { recursive: true, force: true });
      }

      if (!pgliteAlreadyRunning) {
        pgliteChild = spawn(bun, ["run", "packages/scripts/dev/pglite-server.ts"], {
          stdio: ["ignore", "inherit", "inherit"],
          env: {
            ...testEnv,
            PGLITE_HOST: pgliteHost,
            PGLITE_PORT: String(pglitePort),
            PGLITE_MAX_CONNECTIONS: pgliteMaxConnections,
            ...(dataDir ? { PGLITE_DATA_DIR: dataDir } : {}),
          },
        });
        await waitForTcp(pgliteChild, pgliteHost, pglitePort);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } else {
      testEnv.DATABASE_URL = configuredDbUrl;
      testEnv.TEST_DATABASE_URL = configuredDbUrl;
    }

    const migrateResult = spawnSync(bun, ["run", "db:migrate"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: testEnv,
    });
    if (migrateResult.error) {
      throw migrateResult.error;
    }
    if (migrateResult.status !== 0) {
      throw new Error(`db:migrate exited with code ${migrateResult.status}`);
    }

    const workerEnv = {
      ...testEnv,
      NODE_ENV: "development",
      TEST_API_BASE_URL: baseUrl,
    };

    if (!(await healthOk())) {
      const syncResult = spawnSync(bun, ["run", "packages/scripts/sync-api-dev-vars.ts"], {
        stdio: "inherit",
        env: workerEnv,
      });
      if (syncResult.error) {
        throw syncResult.error;
      }
      if (syncResult.status !== 0) {
        throw new Error(`sync-api-dev-vars exited with code ${syncResult.status}`);
      }

      child = spawn(
        bun,
        [
          "run",
          "--cwd",
          "apps/api",
          "wrangler",
          "dev",
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--local",
          "--persist-to",
          `.wrangler/state-e2e-${port}`,
          "--live-reload=false",
          "--show-interactive-dev-session=false",
        ],
        {
          stdio: ["pipe", "inherit", "inherit"],
          env: workerEnv,
        },
      );
      child.on("exit", (code, signal) => {
        workerExit = { code, signal };
      });

      await waitForHealth(child);
    }

    result = spawnSync(bun, ["run", "--cwd", "apps/api", "test:e2e"], {
      stdio: "inherit",
      env: workerEnv,
    });
  } finally {
    if (child) {
      child.kill("SIGTERM");
    }
    if (pgliteChild) {
      pgliteChild.kill("SIGTERM");
    }
  }

  if (result?.error) {
    throw result.error;
  }
  if (result?.status !== 0 && workerExit) {
    console.error(
      `[worker-e2e] Wrangler exited during test run: code=${workerExit.code} signal=${workerExit.signal}`,
    );
  }
  process.exit(result?.status ?? 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
