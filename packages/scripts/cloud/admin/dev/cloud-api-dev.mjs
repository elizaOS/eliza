#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const require = createRequire(import.meta.url);
const rawArgs = process.argv.slice(2);
const withControlPlane = rawArgs.includes("--with-control-plane");
const args = rawArgs.filter((a) => a !== "--with-control-plane");
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

function isRealNodeExecutable(candidate) {
  if (!candidate || !existsSync(candidate)) return false;
  const result = spawnSync(
    candidate,
    ["-e", "process.exit(process.versions.bun ? 1 : 0)"],
    { stdio: "ignore" },
  );
  return result.status === 0;
}

function nodeExecutable() {
  const candidates = [
    process.env.NODE,
    process.execPath,
    ...(process.env.PATH?.split(path.delimiter).map((entry) =>
      path.resolve(entry, "node"),
    ) ?? []),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isRealNodeExecutable(candidate)) return candidate;
  }
  return "node";
}

function wranglerScript() {
  return require.resolve("wrangler/bin/wrangler.js", {
    paths: [path.join(repoRoot, "packages", "cloud-api")],
  });
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

  // When the e2e harness runs (NODE_ENV=test), force the KMS backend to
  // the in-memory adapter via `--var`. wrangler's `[vars] NODE_ENV =
  // "production"` block in wrangler.toml takes precedence over the shell
  // NODE_ENV, which would otherwise cause `resolveKmsBackend()` in
  // `@elizaos/security/kms` to default to the Steward backend and throw
  // `KmsError("ELIZA_KMS_BACKEND=steward requires steward.{baseUrl, tokenProvider}")`
  // for any route that touches encrypted fields (e.g. /api/v1/api-keys/*,
  // /api/v1/api-keys/explorer). The integration suite expects these
  // routes to return 2xx with a working in-memory key store.
  const isE2eTestMode =
    process.env.NODE_ENV === "test" || process.env.CLOUD_E2E === "1";
  // In e2e/test mode, also stub the Cloudflare registrar/DNS by default so the
  // domain buy/check routes never hit the real Cloudflare API (overridable via
  // ELIZA_CF_REGISTRAR_DEV_STUB).
  const registrarStub = process.env.ELIZA_CF_REGISTRAR_DEV_STUB ?? "1";
  const testModeVars = isE2eTestMode
    ? [
        "--var",
        "NODE_ENV:test",
        "--var",
        "ELIZA_KMS_BACKEND:memory",
        "--var",
        `ELIZA_CF_REGISTRAR_DEV_STUB:${registrarStub}`,
      ]
    : [];

  const wranglerArgs =
    args.length > 0
      ? args
      : [
          "dev",
          "--ip",
          "127.0.0.1",
          "--port",
          apiPort,
          "--local",
          ...testModeVars,
        ];

  const useNodeWrangler = env.CLOUD_E2E === "1" && env.NODE_ENV === "test";
  const wranglerCmd = useNodeWrangler ? nodeExecutable() : bun;
  const wranglerSpawnArgs = useNodeWrangler
    ? [wranglerScript(), ...wranglerArgs]
    : ["run", "wrangler", ...wranglerArgs];
  const wrangler = spawn(wranglerCmd, wranglerSpawnArgs, {
    cwd: path.join(repoRoot, "packages", "cloud-api"),
    env,
    stdio: "inherit",
  });

  // When --with-control-plane is passed, also boot the container-control-plane
  // bun service on :8791 so the cloud-api can forward provisioning jobs to it
  // (otherwise provision endpoints succeed but jobs queue forever).
  let controlPlane = null;
  if (withControlPlane) {
    const controlPlaneEnv = {
      ...env,
      // Control-plane reads DATABASE_URL directly (not through dev-vars).
      DATABASE_URL:
        env.DATABASE_URL || `postgresql://postgres@${host}:${port}/postgres`,
      ELIZA_LOCAL_DOCKER_PROVIDER: env.ELIZA_LOCAL_DOCKER_PROVIDER || "1",
      ENVIRONMENT: env.ENVIRONMENT || "local",
      ELIZA_AGENT_IMAGE: env.ELIZA_AGENT_IMAGE || "eliza-cloud-agent:local",
      ELIZA_AGENT_PORT: env.ELIZA_AGENT_PORT || "2138",
      ELIZA_AGENT_BRIDGE_PORT: env.ELIZA_AGENT_BRIDGE_PORT || "18790",
      NEXT_PUBLIC_API_URL:
        env.NEXT_PUBLIC_API_URL || `http://127.0.0.1:${apiPort}`,
    };
    console.log("[cloud-api-dev] starting container-control-plane on :8791");
    controlPlane = spawn(bun, ["run", "start"], {
      cwd: path.join(
        repoRoot,
        "packages",
        "cloud-services",
        "container-control-plane",
      ),
      env: controlPlaneEnv,
      stdio: "inherit",
    });
    controlPlane.on("exit", (code) => {
      console.warn(`[cloud-api-dev] control-plane exited (code ${code})`);
    });
  }

  const shutdown = () => {
    wrangler.kill("SIGTERM");
    controlPlane?.kill("SIGTERM");
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
