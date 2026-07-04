#!/usr/bin/env node
// Drives cloud admin cloud admin dev cloud api dev automation with explicit environment and CI invariants.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const cloudApiDir = path.join(repoRoot, "packages", "cloud", "api");
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
  // On Windows, Node can spawn `bun.exe` directly but NOT the extensionless npm
  // shim (`spawn ENOENT`) nor a `.cmd` without `shell: true`. Probe the native
  // `.exe` first so the npm shim never wins. On POSIX the binary is just `bun`.
  const names = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const dirs = [
    path.resolve(home, ".bun/bin"),
    ...(process.env.PATH?.split(path.delimiter) ?? []),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  if (process.env.npm_execpath?.includes("bun"))
    return process.env.npm_execpath;
  return process.platform === "win32" ? "bun.exe" : "bun";
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
  // wrangler's package.json `exports` does not expose `bin/wrangler.js` as a
  // subpath, so require.resolve("wrangler/bin/wrangler.js") throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED on wrangler >=4. Resolve the package via its
  // (exported) package.json and read the declared bin path instead.
  const pkgJsonPath = require.resolve("wrangler/package.json", {
    paths: [cloudApiDir, repoRoot],
  });
  const pkg = require(pkgJsonPath);
  const binRel =
    typeof pkg.bin === "string"
      ? pkg.bin
      : (pkg.bin?.wrangler ?? "bin/wrangler.js");
  return path.join(path.dirname(pkgJsonPath), binRel);
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

  // When the e2e harness runs (NODE_ENV=test), forward the test KMS backend via
  // `--var`. wrangler's `[vars] NODE_ENV = "production"` block in wrangler.toml
  // takes precedence over the shell NODE_ENV, which would otherwise cause
  // `resolveKmsBackend()` in `@elizaos/security/kms` to default to the Steward
  // backend and throw `KmsError("ELIZA_KMS_BACKEND=steward requires
  // steward.{baseUrl, tokenProvider}")` for any route that touches encrypted
  // fields. Cross-process e2e flows use the local backend with a deterministic
  // root key so Worker routes can decrypt rows written by the control plane.
  const isE2eTestMode =
    process.env.NODE_ENV === "test" || process.env.CLOUD_E2E === "1";
  const kmsBackend = process.env.ELIZA_KMS_BACKEND ?? "memory";
  const localRootKey = process.env.ELIZA_LOCAL_ROOT_KEY;
  // In e2e/test mode, also stub the Cloudflare registrar/DNS by default so the
  // domain buy/check routes never hit the real Cloudflare API (overridable via
  // ELIZA_CF_REGISTRAR_DEV_STUB).
  const registrarStub = process.env.ELIZA_CF_REGISTRAR_DEV_STUB ?? "1";
  // In e2e/test mode, neutralize the dedicated-agent public subdomain. The agent
  // detail route synthesizes `web_ui_url = https://<id>.<ELIZA_CLOUD_AGENT_BASE_DOMAIN>`
  // (wrangler.toml pins `elizacloud.ai`), and the client's readiness probe prefers
  // that web_ui_url over the agent's `bridge_url`. There is no Worker-fronted
  // `*.elizacloud.ai` ingress in the local mock stack, so that subdomain is
  // unreachable — the dedicated agent's reachable base IS its `bridge_url` (the
  // control-plane mock). The detail route feeds `containersEnv.publicBaseDomain()`
  // into `getElizaAgentPublicWebUiUrl` as the EXPLICIT `{baseDomain}` option; a
  // value that normalizes to empty makes that explicit-option path return null, so
  // the reachable bridge wins and the shared→dedicated handoff import can complete.
  // (The compat-envelope no-option path keeps its default and is intentionally not
  // neutralized.) The apps domain (`CONTAINERS_PUBLIC_BASE_DOMAIN`) is a separate
  // knob and is left untouched.
  const agentBaseDomainOverride =
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN ?? "https://";
  const testModeVars = isE2eTestMode
    ? [
        "--var",
        "NODE_ENV:test",
        "--var",
        `ELIZA_KMS_BACKEND:${kmsBackend}`,
        ...(localRootKey
          ? ["--var", `ELIZA_LOCAL_ROOT_KEY:${localRootKey}`]
          : []),
        "--var",
        `ELIZA_CF_REGISTRAR_DEV_STUB:${registrarStub}`,
        "--var",
        `ELIZA_CLOUD_AGENT_BASE_DOMAIN:${agentBaseDomainOverride}`,
      ]
    : [];
  // Redis selection must reach the Worker's `c.env`, not just this launcher's
  // process.env: routes build their client via `buildRedisClient(c.env)`, and
  // wrangler `--local` only exposes vars passed through wrangler.toml/.dev.vars/
  // `--var` — ambient process.env does NOT leak into `c.env`. Without this, the
  // e2e env's `MOCK_REDIS=1` is invisible inside the Worker and any nonce-storage
  // route (e.g. SIWE nonce/verify) returns 503 "Nonce storage unavailable". Most
  // redis consumers (rate-limit) fail open, so this only surfaced once a spec
  // drove the real SIWE login. Forward whichever redis selector is set.
  const redisDevVars = ["MOCK_REDIS", "REDIS_URL"].flatMap((key) => {
    const value = process.env[key];
    return value ? ["--var", `${key}:${value}`] : [];
  });
  const appDeployDevVars = [
    "APPS_DEPLOY_ENABLED",
    "APPS_DEPLOY_ALLOWED_ORG_IDS",
    "APP_DEFAULT_IMAGE",
  ].flatMap((key) => {
    const value = process.env[key];
    return value ? ["--var", `${key}:${value}`] : [];
  });

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
          ...redisDevVars,
          ...appDeployDevVars,
        ];

  const useNodeWrangler = env.CLOUD_E2E === "1" && env.NODE_ENV === "test";
  const wranglerCmd = useNodeWrangler ? nodeExecutable() : bun;
  const wranglerSpawnArgs = useNodeWrangler
    ? [wranglerScript(), ...wranglerArgs]
    : ["run", "wrangler", ...wranglerArgs];
  const wrangler = spawn(wranglerCmd, wranglerSpawnArgs, {
    cwd: cloudApiDir,
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
