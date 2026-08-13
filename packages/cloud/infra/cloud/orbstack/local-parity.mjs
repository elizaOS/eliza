#!/usr/bin/env node
/**
 * Orchestrates isolated staging and production profiles on OrbStack.
 * Kubernetes owns persistent dependencies; workerd, the app, the control plane,
 * and real Docker agent containers retain the same process boundaries as cloud.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const templatePath = path.join(import.meta.dirname, "dependencies.yaml");
const stateRoot = path.join(repoRoot, ".eliza", "local-parity");
const allowedProfiles = new Set(["staging", "production"]);
const processNames = [
  "postgres-forward",
  "redis-forward",
  "openai-mock",
  "cloud-api",
  "app",
];

export const profiles = Object.freeze({
  staging: Object.freeze({
    namespace: "eliza-local-staging",
    postgresPort: 15432,
    redisPort: 16379,
    apiPort: 18787,
    controlPlanePort: 18791,
    appPort: 14173,
    openAiPort: 18080,
  }),
  production: Object.freeze({
    namespace: "eliza-local-production",
    postgresPort: 25432,
    redisPort: 26379,
    apiPort: 28787,
    controlPlanePort: 28791,
    appPort: 24173,
    openAiPort: 28080,
  }),
});

export function renderDependencies(profile) {
  const config = getProfile(profile);
  return readFileSync(templatePath, "utf8")
    .replaceAll("__NAMESPACE__", config.namespace)
    .replaceAll("__PROFILE__", profile);
}

export function getProfile(profile) {
  if (!allowedProfiles.has(profile)) {
    throw new Error(
      `Profile must be staging or production, received ${JSON.stringify(profile)}`,
    );
  }
  return profiles[profile];
}

function parseArgs(argv) {
  const command = argv[0] ?? "help";
  let profile = "staging";
  let app = true;
  let buildAgent = true;
  let follow = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profile = argv[index + 1];
      index += 1;
    } else if (arg === "--no-app") app = false;
    else if (arg === "--skip-agent-image") buildAgent = false;
    else if (arg === "--follow" || arg === "-f") follow = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, profile, app, buildAgent, follow };
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${bin} ${args.join(" ")} failed (${result.status})${detail ? `:\n${detail}` : ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

export function assertOrbStackContexts() {
  const dockerContext = run("docker", ["context", "show"]);
  const kubernetesContext = run("kubectl", ["config", "current-context"]);
  validateOrbStackContexts(dockerContext, kubernetesContext);
}

export function validateOrbStackContexts(dockerContext, kubernetesContext) {
  if (dockerContext !== "orbstack" || kubernetesContext !== "orbstack") {
    throw new Error(
      `Refusing to mutate non-OrbStack targets (docker=${dockerContext}, kubernetes=${kubernetesContext}). ` +
        "Select the orbstack Docker and Kubernetes contexts first.",
    );
  }
}

function ensureOrbStack() {
  const status = spawnSync("orbctl", ["status"], { encoding: "utf8" });
  if (status.status !== 0 || !status.stdout.includes("Running")) {
    run("orbctl", ["start", "k8s"], { stdio: "inherit" });
  }
  assertOrbStackContexts();
  run("kubectl", ["--context", "orbstack", "get", "nodes"], {
    stdio: "ignore",
  });
}

function profileDir(profile) {
  getProfile(profile);
  return path.join(stateRoot, profile);
}

function statePath(profile) {
  return path.join(profileDir(profile), "state.json");
}

function readState(profile) {
  const file = statePath(profile);
  if (!existsSync(file)) return { profile, processes: {} };
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.profile !== profile || typeof value.processes !== "object") {
    throw new Error(`Invalid local parity state at ${file}`);
  }
  return value;
}

function writeState(profile, state) {
  mkdirSync(profileDir(profile), { recursive: true });
  writeFileSync(
    statePath(profile),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // error-policy:J4 a missing process is the explicit stopped state shown by status/up.
    return false;
  }
}

function startManaged(profile, name, bin, args, env = {}) {
  const state = readState(profile);
  const existing = state.processes[name];
  if (existing && isAlive(existing.pid)) return existing.pid;
  mkdirSync(profileDir(profile), { recursive: true });
  const logPath = path.join(profileDir(profile), `${name}.log`);
  const logFd = openSync(logPath, "a");
  const child = spawn(bin, args, {
    cwd: repoRoot,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  state.processes[name] = {
    pid: child.pid,
    logPath,
    startedAt: new Date().toISOString(),
  };
  writeState(profile, state);
  return child.pid;
}

async function waitForTcp(port, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(750);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become reachable on 127.0.0.1:${port}`);
}

async function waitForHttp(url, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.status < 500) return;
    } catch {
      // error-policy:J4 startup unavailability stays pending until the deadline fails visibly.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

function databaseUrl(config) {
  return `postgresql://eliza:local-parity-only@127.0.0.1:${config.postgresPort}/eliza`;
}

function localEnvironment(profile, config) {
  const apiUrl = `http://127.0.0.1:${config.apiPort}`;
  return {
    API_DEV_PORT: String(config.apiPort),
    CACHE_BACKEND: "redis",
    CACHE_ENABLED: "true",
    CLOUD_E2E: "1",
    CONTAINER_CONTROL_PLANE_PORT: String(config.controlPlanePort),
    CONTAINER_CONTROL_PLANE_TOKEN: `local-${profile}-control-plane-token`,
    CONTAINER_CONTROL_PLANE_URL: `http://127.0.0.1:${config.controlPlanePort}`,
    CRON_SECRET: "test-cron-secret",
    DATABASE_URL: databaseUrl(config),
    TEST_DATABASE_URL: databaseUrl(config),
    ELIZA_AGENT_IMAGE: "eliza-cloud-agent:local",
    ELIZA_CF_REGISTRAR_DEV_STUB: "1",
    ELIZA_CLOUD_AGENT_BASE_DOMAIN: "https://",
    ELIZA_CLOUD_LOCAL_API_URL: apiUrl,
    ELIZA_CLOUD_LOCAL_APP_URL: `http://127.0.0.1:${config.appPort}`,
    ELIZA_CLOUD_LOCAL_PROFILE: profile,
    ELIZA_KMS_BACKEND: "memory",
    ELIZA_LOCAL_DOCKER_HOST_SUFFIX: "orb.local",
    ELIZA_LOCAL_DOCKER_PROVIDER: "1",
    ELIZA_LOCAL_PARITY_PROFILE: profile,
    ELIZA_LOCAL_ROOT_KEY: `local-${profile}-root-key-not-for-production`,
    ELIZA_WORKER_ALLOW_PRIVATE_NETWORK: "1",
    ENVIRONMENT: "local",
    NODE_ENV: "test",
    OPENAI_API_KEY: "local-parity-only",
    OPENAI_BASE_URL: `http://127.0.0.1:${config.openAiPort}/v1`,
    PRESERVE_E2E_PROVIDER_ENV: "1",
    REDIS_URL: `redis://127.0.0.1:${config.redisPort}`,
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
      databaseUrl(config),
  };
}

async function up(profile, options) {
  const config = getProfile(profile);
  ensureOrbStack();
  mkdirSync(profileDir(profile), { recursive: true });
  run("kubectl", ["--context", "orbstack", "apply", "-f", "-"], {
    input: renderDependencies(profile),
    stdio: ["pipe", "inherit", "inherit"],
  });
  run(
    "kubectl",
    [
      "--context",
      "orbstack",
      "-n",
      config.namespace,
      "rollout",
      "status",
      "statefulset/postgres",
      "--timeout=180s",
    ],
    { stdio: "inherit" },
  );
  run(
    "kubectl",
    [
      "--context",
      "orbstack",
      "-n",
      config.namespace,
      "rollout",
      "status",
      "statefulset/redis",
      "--timeout=180s",
    ],
    { stdio: "inherit" },
  );

  startManaged(profile, "postgres-forward", "kubectl", [
    "--context",
    "orbstack",
    "-n",
    config.namespace,
    "port-forward",
    "service/postgres",
    `${config.postgresPort}:5432`,
  ]);
  startManaged(profile, "redis-forward", "kubectl", [
    "--context",
    "orbstack",
    "-n",
    config.namespace,
    "port-forward",
    "service/redis",
    `${config.redisPort}:6379`,
  ]);
  await Promise.all([
    waitForTcp(config.postgresPort, "PostgreSQL"),
    waitForTcp(config.redisPort, "Redis"),
  ]);

  if (options.buildAgent) {
    run(
      "bun",
      ["run", "packages/cloud/scripts/admin/dev/build-cloud-agent-image.mjs"],
      {
        stdio: "inherit",
      },
    );
  }

  const env = localEnvironment(profile, config);
  startManaged(
    profile,
    "openai-mock",
    "bun",
    ["run", "packages/cloud/test-mocks/bin/openai-mock.ts"],
    {
      OPENAI_MOCK_PORT: String(config.openAiPort),
      OPENAI_MOCK_ECHO_CONTEXT: "1",
    },
  );
  await waitForHttp(
    `http://127.0.0.1:${config.openAiPort}/health`,
    "OpenAI mock",
  );

  startManaged(
    profile,
    "cloud-api",
    "bun",
    [
      "run",
      "packages/cloud/scripts/admin/dev/cloud-api-dev.mjs",
      "--with-control-plane",
      "--allow-private-network",
      "dev",
      "--env",
      profile,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(config.apiPort),
      "--persist-to",
      path.join(profileDir(profile), "workerd"),
    ],
    env,
  );
  await waitForHttp(
    `http://127.0.0.1:${config.apiPort}/api/health`,
    "cloud API",
  );
  await waitForHttp(
    `http://127.0.0.1:${config.controlPlanePort}/health`,
    "container control plane",
  );

  if (options.app) {
    startManaged(
      profile,
      "app",
      "bun",
      [
        "run",
        "--cwd",
        "packages/app",
        "dev",
        "--",
        "--host",
        "127.0.0.1",
        "--port",
        String(config.appPort),
      ],
      {
        VITE_ELIZA_CLOUD_BASE: `http://127.0.0.1:${config.apiPort}`,
        VITE_CLOUD_BASE: `http://127.0.0.1:${config.apiPort}`,
      },
    );
    await waitForHttp(`http://127.0.0.1:${config.appPort}`, "Eliza app");
  }
  printStatus(profile);
}

function stopProcess(pid) {
  if (!isAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // error-policy:J6 teardown falls back when process-group signalling is unavailable.
    process.kill(pid, "SIGTERM");
  }
}

function profileContainerIds(profile) {
  const output = run("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=ai.elizaos.local-parity-profile=${profile}`,
  ]);
  return output ? output.split("\n").filter(Boolean) : [];
}

function down(profile) {
  const config = getProfile(profile);
  ensureOrbStack();
  const state = readState(profile);
  for (const name of processNames.toReversed()) {
    const entry = state.processes[name];
    if (entry) stopProcess(entry.pid);
  }
  state.processes = {};
  writeState(profile, state);
  const containers = profileContainerIds(profile);
  if (containers.length > 0)
    run("docker", ["stop", ...containers], { stdio: "inherit" });
  const namespaceExists =
    spawnSync(
      "kubectl",
      ["--context", "orbstack", "get", "namespace", config.namespace],
      { stdio: "ignore" },
    ).status === 0;
  if (namespaceExists) {
    run(
      "kubectl",
      [
        "--context",
        "orbstack",
        "-n",
        config.namespace,
        "scale",
        "statefulset/postgres",
        "statefulset/redis",
        "--replicas=0",
      ],
      { stdio: "inherit" },
    );
  }
  console.log(
    `[local-parity] ${profile} stopped; Kubernetes PVC data is preserved`,
  );
}

function reset(profile) {
  const config = getProfile(profile);
  down(profile);
  const containers = profileContainerIds(profile);
  if (containers.length > 0)
    run("docker", ["rm", "-f", ...containers], { stdio: "inherit" });
  const namespaceExists =
    spawnSync(
      "kubectl",
      ["--context", "orbstack", "get", "namespace", config.namespace],
      { stdio: "ignore" },
    ).status === 0;
  if (namespaceExists) {
    run(
      "kubectl",
      [
        "--context",
        "orbstack",
        "delete",
        "namespace",
        config.namespace,
        "--wait=true",
      ],
      {
        stdio: "inherit",
      },
    );
  }
  run("node", ["packages/scripts/rm-path-recursive.mjs", profileDir(profile)], {
    stdio: "inherit",
  });
  console.log(
    `[local-parity] reset ${profile}; its namespace, PVCs, containers, and local state were removed`,
  );
}

function printStatus(profile) {
  const config = getProfile(profile);
  assertOrbStackContexts();
  const state = readState(profile);
  console.log(`profile=${profile} namespace=${config.namespace}`);
  for (const name of processNames) {
    const entry = state.processes[name];
    console.log(
      `${name}=${entry && isAlive(entry.pid) ? `running(pid=${entry.pid})` : "stopped"}`,
    );
  }
  run(
    "kubectl",
    ["--context", "orbstack", "-n", config.namespace, "get", "pods,pvc"],
    {
      stdio: "inherit",
    },
  );
  run(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=ai.elizaos.local-parity-profile=${profile}`,
      "--format",
      "table {{.Names}}\t{{.Status}}\t{{.Ports}}",
    ],
    { stdio: "inherit" },
  );
  console.log(
    `api=http://127.0.0.1:${config.apiPort} app=http://127.0.0.1:${config.appPort}`,
  );
}

function logs(profile, follow) {
  const state = readState(profile);
  const files = processNames
    .map(
      (name) =>
        state.processes[name]?.logPath ??
        path.join(profileDir(profile), `${name}.log`),
    )
    .filter((file) => existsSync(file));
  if (files.length === 0) throw new Error(`No logs found for ${profile}`);
  run(
    "tail",
    follow ? ["-n", "200", "-f", ...files] : ["-n", "200", ...files],
    {
      stdio: "inherit",
    },
  );
}

function help() {
  console.log(
    `Usage: bun run cloud:local <command> [options]\n\nCommands:\n  up       Start or converge the profile\n  status   Inspect processes, pods, PVCs, and agent containers\n  logs     Tail profile logs\n  smoke    Run the real local provisioning smoke test\n  down     Stop services and pods while preserving PVCs\n  reset    Delete only this profile's local state\n\nOptions:\n  --profile staging|production\n  --no-app\n  --skip-agent-image\n  --follow, -f`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (
    options.command === "help" ||
    options.command === "--help" ||
    options.command === "-h"
  ) {
    help();
    return;
  }
  getProfile(options.profile);
  if (options.command === "up") await up(options.profile, options);
  else if (options.command === "status") printStatus(options.profile);
  else if (options.command === "logs") logs(options.profile, options.follow);
  else if (options.command === "down") down(options.profile);
  else if (options.command === "reset") reset(options.profile);
  else if (options.command === "smoke") {
    const config = getProfile(options.profile);
    run(
      "bun",
      [
        "run",
        path.join(import.meta.dirname, "smoke.ts"),
        "--profile",
        options.profile,
      ],
      {
        env: { ...process.env, ...localEnvironment(options.profile, config) },
        stdio: "inherit",
      },
    );
  } else throw new Error(`Unknown command: ${options.command}`);
}

if (import.meta.main) {
  // error-policy:J1 the command boundary prints a failure and exits non-zero.
  main().catch((error) => {
    console.error(
      `[local-parity] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
