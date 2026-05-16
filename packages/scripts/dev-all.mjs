#!/usr/bin/env node
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const fullPrepare =
  args.has("--full-prepare") || process.env.DEV_ALL_FULL_PREPARE === "1";
const skipPrepare =
  args.has("--no-prepare") || process.env.DEV_ALL_SKIP_PREPARE === "1";
const skipCloudDb =
  args.has("--no-cloud-db") || process.env.DEV_ALL_SKIP_CLOUD_DB === "1";
const enableTestAuth =
  args.has("--test-auth") ||
  process.env.DEV_ALL_ENABLE_TEST_AUTH !== "0";

const repoRoot = process.cwd();
const bunBin =
  process.env.BUN_BIN ||
  (process.env.npm_execpath?.includes("bun")
    ? process.env.npm_execpath
    : undefined) ||
  (process.env.BUN_INSTALL
    ? `${process.env.BUN_INSTALL}/bin/bun`
    : undefined) ||
  "bun";

function envDefault(key, value) {
  return process.env[key]?.trim() || value;
}

const ports = {
  agentApi: envDefault("DEV_ALL_AGENT_API_PORT", "2138"),
  frontend: envDefault("DEV_ALL_FRONTEND_PORT", "5173"),
  homepage: envDefault("DEV_ALL_HOMEPAGE_PORT", "4444"),
  osHomepage: envDefault("DEV_ALL_OS_HOMEPAGE_PORT", "4455"),
  cloudWeb: envDefault("DEV_ALL_CLOUD_WEB_PORT", "3000"),
  cloudApi: envDefault("DEV_ALL_CLOUD_API_PORT", "8787"),
  cloudDb: envDefault("DEV_ALL_CLOUD_DB_PORT", "55432"),
};

const urls = {
  agentApi: `http://127.0.0.1:${ports.agentApi}`,
  frontend: `http://localhost:${ports.frontend}`,
  homepage: `http://localhost:${ports.homepage}`,
  osHomepage: `http://localhost:${ports.osHomepage}`,
  cloudWeb: `http://localhost:${ports.cloudWeb}`,
  cloudApi: `http://localhost:${ports.cloudApi}`,
  cloudDb: `postgresql://postgres@127.0.0.1:${ports.cloudDb}/postgres`,
};
const localTestAuthSecret = envDefault(
  "PLAYWRIGHT_TEST_AUTH_SECRET",
  "playwright-local-auth-secret",
);
const serviceStartupTimeoutMs = Number.parseInt(
  envDefault("DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS", "120000"),
  10,
);

const packagedCloudAvailable =
  existsSync(`${repoRoot}/packages/cloud-api/package.json`) &&
  existsSync(`${repoRoot}/packages/cloud-frontend/package.json`);
const cloudMode = packagedCloudAvailable ? "packages" : "legacy";
const commonEnv = { ...process.env, NODE_ENV: "development" };
const cloudSharedEnv = {
  ...commonEnv,
  API_DEV_PORT: ports.cloudApi,
  DATABASE_URL: envDefault("DATABASE_URL", urls.cloudDb),
  ELIZA_CLOUD_LOCAL_APP_URL: urls.cloudWeb,
  ELIZA_CLOUD_LOCAL_API_URL: urls.cloudApi,
  NEXT_PUBLIC_APP_URL: urls.cloudWeb,
  NEXT_PUBLIC_API_URL: urls.cloudApi,
  NEXT_PUBLIC_ELIZA_APP_URL: urls.homepage,
  NEXT_PUBLIC_ELIZA_API_URL: urls.cloudApi,
  NEXT_PUBLIC_ELIZA_PROXY_URL: urls.cloudWeb,
  NEXT_PUBLIC_STEWARD_API_URL: `${urls.cloudApi}/steward`,
  VITE_ELIZA_APP_URL: urls.homepage,
  VITE_ELIZA_CLOUD_URL: urls.cloudWeb,
  VITE_ELIZA_OS_URL: urls.osHomepage,
  ...(enableTestAuth
    ? {
        AGENT_TEST_BOOTSTRAP_ADMIN: "true",
        PLAYWRIGHT_TEST_AUTH: "true",
        PLAYWRIGHT_TEST_AUTH_SECRET: localTestAuthSecret,
        RATE_LIMIT_DISABLED: "true",
      }
    : {}),
  VITE_API_PROXY_TARGET: urls.cloudApi,
  VITE_ALLOWED_HOSTS: [
    "localhost",
    "127.0.0.1",
    "::1",
    process.env.VITE_ALLOWED_HOSTS,
  ]
    .filter(Boolean)
    .join(","),
};
const agentEnv = {
  ...commonEnv,
  API_PORT: ports.agentApi,
  SERVER_PORT: ports.agentApi,
  ELIZA_PORT: ports.agentApi,
  ELIZA_API_PORT: ports.agentApi,
  ELIZA_UI_ENABLE: "true",
  ELIZA_API_BIND: envDefault("ELIZA_API_BIND", "127.0.0.1"),
  ELIZAOS_CLOUD_BASE_URL: envDefault(
    "ELIZAOS_CLOUD_BASE_URL",
    `${urls.cloudApi}/api/v1`,
  ),
  ELIZA_CLOUD_URL: urls.cloudWeb,
  ELIZA_WALLET_OS_STORE: envDefault("ELIZA_WALLET_OS_STORE", "0"),
  ELIZA_ALLOW_NO_PROVIDER: envDefault("ELIZA_ALLOW_NO_PROVIDER", "1"),
  ELIZA_DISABLE_LOCAL_EMBEDDINGS: envDefault(
    "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
    "true",
  ),
  ELIZA_SKIP_PLUGINS: [
    process.env.ELIZA_SKIP_PLUGINS,
    "@elizaos/plugin-companion",
    "@elizaos/plugin-lifeops",
    "@elizaos/plugin-wallet",
  ]
    .filter(Boolean)
    .join(","),
  PGLITE_DATA_DIR: envDefault(
    "DEV_ALL_AGENT_PGLITE_DATA_DIR",
    `${repoRoot}/.eliza/agent-pglite`,
  ),
  EVM_PRIVATE_KEY: "",
  SOLANA_PRIVATE_KEY: "",
};
const frontendEnv = {
  ...commonEnv,
  PORT: ports.frontend,
  ELIZA_UI_PORT: ports.frontend,
  ELIZA_API_PORT: ports.agentApi,
  ELIZA_PORT: ports.agentApi,
  VITE_ELIZA_CLOUD_BASE: urls.cloudWeb,
  VITE_ELIZA_IOS_API_BASE: urls.cloudApi,
  VITE_ELIZACLOUD_API_URL: urls.cloudApi,
  VITE_ASSET_BASE_URL: envDefault(
    "VITE_ASSET_BASE_URL",
    "https://blob.elizacloud.ai",
  ),
  VITE_ELIZA_APP_URL: urls.homepage,
  VITE_ELIZA_CLOUD_URL: urls.cloudWeb,
  VITE_ELIZA_OS_URL: urls.osHomepage,
  ...(enableTestAuth ? { VITE_PLAYWRIGHT_TEST_AUTH: "true" } : {}),
};
const homepageEnv = {
  ...commonEnv,
  PORT: ports.homepage,
  VITE_ELIZACLOUD_API_URL: urls.cloudApi,
  VITE_ELIZA_APP_URL: urls.homepage,
  VITE_ELIZA_CLOUD_URL: urls.cloudWeb,
  VITE_ELIZA_OS_URL: urls.osHomepage,
  ...(enableTestAuth ? { VITE_PLAYWRIGHT_TEST_AUTH: "true" } : {}),
};
const osHomepageEnv = {
  ...commonEnv,
  PORT: ports.osHomepage,
  VITE_ELIZACLOUD_API_URL: urls.cloudApi,
  VITE_ELIZA_APP_URL: urls.homepage,
  VITE_ELIZA_CLOUD_URL: urls.cloudWeb,
  VITE_ELIZA_OS_URL: urls.osHomepage,
  ...(enableTestAuth ? { VITE_PLAYWRIGHT_TEST_AUTH: "true" } : {}),
};
const cloudDbEnv = {
  ...cloudSharedEnv,
  PGLITE_PORT: ports.cloudDb,
  PGLITE_HOST: "127.0.0.1",
};
const cloudApiService = packagedCloudAvailable
  ? { cwd: "packages/cloud-api", command: [bunBin, "run", "dev"] }
  : { cwd: "cloud", command: [bunBin, "run", "dev:api"] };
const cloudWebService = packagedCloudAvailable
  ? {
      cwd: "packages/cloud-frontend",
      command: [
        bunBin,
        "run",
        "dev",
        "--",
        "--host",
        "0.0.0.0",
        "--port",
        ports.cloudWeb,
      ],
    }
  : {
      cwd: "cloud",
      command: [
        bunBin,
        "run",
        "dev:web",
        "--",
        "--host",
        "0.0.0.0",
        "--port",
        ports.cloudWeb,
      ],
    };

const services = [
  !skipCloudDb && {
    name: "cloud-db",
    cwd: ".",
    command: [bunBin, "run", "db:cloud:pglite"],
    env: cloudDbEnv,
  },
  { name: "cloud-api", ...cloudApiService, env: cloudSharedEnv },
  {
    name: "cloud-web",
    ...cloudWebService,
    env: { ...cloudSharedEnv, PORT: ports.cloudWeb },
  },
  {
    name: "agent",
    cwd: ".",
    command: [bunBin, "run", "--cwd", "packages/agent", "start"],
    env: agentEnv,
  },
  {
    name: "frontend",
    cwd: "packages/app",
    command: [
      bunBin,
      "run",
      "dev",
      "--",
      "--host",
      "0.0.0.0",
      "--port",
      ports.frontend,
    ],
    env: frontendEnv,
  },
  {
    name: "homepage",
    cwd: "packages/homepage",
    command: [
      bunBin,
      "run",
      "dev",
      "--",
      "--host",
      "0.0.0.0",
      "--port",
      ports.homepage,
    ],
    env: homepageEnv,
  },
  {
    name: "os-homepage",
    cwd: "packages/os-homepage",
    command: [
      bunBin,
      "run",
      "dev",
      "--",
      "--host",
      "0.0.0.0",
      "--port",
      ports.osHomepage,
    ],
    env: osHomepageEnv,
  },
].filter(Boolean);

const cloudDevVarsCommand = packagedCloudAvailable
  ? [bunBin, "run", "packages/scripts/cloud/admin/sync-api-dev-vars.ts"]
  : [bunBin, "run", "--cwd", "cloud", "packages/scripts/sync-api-dev-vars.ts"];
const defaultPrepareCommands = [
  [
    "shared package build",
    "packages/shared",
    [bunBin, "run", "build:dist"],
    commonEnv,
  ],
  ["ui package build", "packages/ui", [bunBin, "run", "build:dist"], commonEnv],
  [
    "wallet plugin build",
    "plugins/plugin-wallet",
    [bunBin, "run", "build"],
    commonEnv,
  ],
  [
    "local inference plugin build",
    "plugins/plugin-local-inference",
    [bunBin, "run", "build"],
    commonEnv,
  ],
  [
    "app plugin build",
    "packages/app",
    [bunBin, "run", "plugin:build"],
    frontendEnv,
  ],
  ["cloud dev vars", ".", cloudDevVarsCommand, cloudSharedEnv],
];
const prepareCommands = fullPrepare
  ? [["dev:prepare", ".", [bunBin, "run", "dev:prepare"], commonEnv]]
  : defaultPrepareCommands;

function printPlan() {
  console.log("[dev:all] local stack");
  console.log(`  agent API:  ${urls.agentApi}`);
  console.log(`  frontend:   ${urls.frontend}`);
  console.log(`  app home:   ${urls.homepage}`);
  console.log(`  OS home:    ${urls.osHomepage}`);
  console.log(`  cloud web:  ${urls.cloudWeb}`);
  console.log(`  cloud API:  ${urls.cloudApi}`);
  console.log(`  cloud src:  ${cloudMode}`);
  if (!skipCloudDb) console.log(`  cloud DB:   ${urls.cloudDb}`);
  console.log(
    `  test auth:  ${enableTestAuth ? "enabled (local only)" : "disabled"}`,
  );
  console.log("");
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(750, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(label, host, port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < serviceStartupTimeoutMs) {
    if (await canConnect(host, port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`[dev:all] ${label} did not start on ${host}:${port}`);
}

function describePortOwner(port) {
  try {
    return execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

async function assertPortsAvailable() {
  const checks = [
    !skipCloudDb && ["cloud DB", "127.0.0.1", ports.cloudDb],
    ["cloud API", "127.0.0.1", ports.cloudApi],
    ["cloud web", "127.0.0.1", ports.cloudWeb],
    ["agent API", "127.0.0.1", ports.agentApi],
    ["frontend", "127.0.0.1", ports.frontend],
    ["app home", "127.0.0.1", ports.homepage],
    ["OS home", "127.0.0.1", ports.osHomepage],
  ].filter(Boolean);

  const occupied = [];
  for (const [label, host, port] of checks) {
    if (await canConnect(host, port)) {
      occupied.push({ label, port, owner: describePortOwner(port) });
    }
  }

  if (occupied.length > 0) {
    const details = occupied
      .map(
        ({ label, port, owner }) =>
          `  ${label} port ${port} is already in use${owner ? `\n${owner}` : ""}`,
      )
      .join("\n\n");
    throw new Error(`[dev:all] cannot start; ports are occupied:\n${details}`);
  }
}

function runOnce(label, cwd, command, env) {
  return new Promise((resolve, reject) => {
    console.log(`[dev:all] ${label}: ${command.join(" ")}`);
    if (dryRun) return resolve();
    const child = spawn(command[0], command.slice(1), {
      cwd: cwd === "." ? repoRoot : `${repoRoot}/${cwd}`,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${signal ?? code}`));
    });
  });
}

function prefixStream(stream, label, target) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) target.write(`[${label}] ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) target.write(`[${label}] ${pending}\n`);
  });
}

function startService(service) {
  console.log(
    `[dev:all] starting ${service.name}: ${service.command.join(" ")}`,
  );
  if (dryRun) return null;
  const child = spawn(service.command[0], service.command.slice(1), {
    cwd: service.cwd === "." ? repoRoot : `${repoRoot}/${service.cwd}`,
    env: service.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  child.serviceName = service.name;
  prefixStream(child.stdout, service.name, process.stdout);
  prefixStream(child.stderr, service.name, process.stderr);
  child.on("error", (error) => {
    console.error(
      `[dev:all] ${service.name} failed to start: ${error.message}`,
    );
  });
  return child;
}

function stopChildren(children) {
  for (const child of children) {
    if (child && !child.killed) child.kill("SIGTERM");
  }
}

function stopChildrenAndExit(children, code) {
  stopChildren(children);
  setTimeout(() => process.exit(code), 1500).unref();
}

async function main() {
  printPlan();
  if (!skipPrepare) {
    if (!fullPrepare) {
      console.log(
        "[dev:all] using targeted prepare (pass --full-prepare for full Turbo build)",
      );
    }
    for (const [label, cwd, command, env] of prepareCommands) {
      await runOnce(label, cwd, command, env);
    }
  } else {
    console.log("[dev:all] skipping prepare steps");
  }

  if (dryRun) return;
  await assertPortsAvailable();
  const children = [];

  const cloudDbService = services.find((service) => service.name === "cloud-db");
  if (cloudDbService) {
    const cloudDb = startService(cloudDbService);
    if (cloudDb) children.push(cloudDb);
    console.log(
      `[dev:all] waiting for cloud DB on 127.0.0.1:${ports.cloudDb}`,
    );
    await waitForPort("cloud DB", "127.0.0.1", ports.cloudDb);
  }

  for (const service of services) {
    if (service.name === "cloud-db") continue;
    const child = startService(service);
    if (child) children.push(child);
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[dev:all] ${signal} received; stopping services`);
    stopChildren(children);
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  for (const child of children) {
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(
        `[dev:all] service ${child.serviceName ?? "unknown"} exited; stopping stack (${signal ?? code})`,
      );
      shuttingDown = true;
      stopChildrenAndExit(children, typeof code === "number" ? code : 1);
    });
  }
}

main().catch((error) => {
  console.error(
    `[dev:all] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
