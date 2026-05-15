#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const fullPrepare =
  args.has("--full-prepare") || process.env.DEV_ALL_FULL_PREPARE === "1";
const skipPrepare =
  args.has("--no-prepare") || process.env.DEV_ALL_SKIP_PREPARE === "1";
const skipCloudDb =
  args.has("--no-cloud-db") || process.env.DEV_ALL_SKIP_CLOUD_DB === "1";

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
  cloudWeb: envDefault("DEV_ALL_CLOUD_WEB_PORT", "3000"),
  cloudApi: envDefault("DEV_ALL_CLOUD_API_PORT", "8787"),
  cloudDb: envDefault("DEV_ALL_CLOUD_DB_PORT", "55432"),
};

const urls = {
  agentApi: `http://127.0.0.1:${ports.agentApi}`,
  frontend: `http://localhost:${ports.frontend}`,
  homepage: `http://localhost:${ports.homepage}`,
  cloudWeb: `http://localhost:${ports.cloudWeb}`,
  cloudApi: `http://localhost:${ports.cloudApi}`,
  cloudDb: `postgresql://postgres@127.0.0.1:${ports.cloudDb}/postgres`,
};

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
  ELIZA_WALLET_OS_STORE: envDefault("ELIZA_WALLET_OS_STORE", "1"),
  ELIZA_DEVICE_BRIDGE_ENABLED: envDefault("ELIZA_DEVICE_BRIDGE_ENABLED", "1"),
  ELIZA_DISABLE_LOCAL_EMBEDDINGS: envDefault(
    "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
    "true",
  ),
  ELIZA_SKIP_PLUGINS: [
    process.env.ELIZA_SKIP_PLUGINS,
    "@elizaos/plugin-companion",
    "@elizaos/plugin-lifeops",
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
};
const homepageEnv = {
  ...commonEnv,
  PORT: ports.homepage,
  VITE_ELIZACLOUD_API_URL: urls.cloudApi,
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
].filter(Boolean);

const cloudDevVarsCommand = packagedCloudAvailable
  ? [bunBin, "run", "packages/scripts/cloud/admin/sync-api-dev-vars.ts"]
  : [bunBin, "run", "--cwd", "cloud", "packages/scripts/sync-api-dev-vars.ts"];
const defaultPrepareCommands = [
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
  console.log(`  homepage:   ${urls.homepage}`);
  console.log(`  cloud web:  ${urls.cloudWeb}`);
  console.log(`  cloud API:  ${urls.cloudApi}`);
  console.log(`  cloud src:  ${cloudMode}`);
  if (!skipCloudDb) console.log(`  cloud DB:   ${urls.cloudDb}`);
  console.log("");
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

  const children = services.map(startService).filter(Boolean);
  if (dryRun) return;

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
        `[dev:all] service exited; stopping stack (${signal ?? code})`,
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
