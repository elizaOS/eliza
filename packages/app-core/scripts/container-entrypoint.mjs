import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CLOUD_MODES = new Set(["cloud", "cloud-agent", "cloud_agent"]);
const AGENT_MODES = new Set(["agent", "default", "eliza"]);
const TSX_LOADER_PATH = "./node_modules/tsx/dist/loader.mjs";

export function normalizeContainerMode(rawMode, env = process.env) {
  const candidate = String(rawMode ?? "")
    .trim()
    .toLowerCase();

  if (CLOUD_MODES.has(candidate)) return "cloud-agent";
  if (AGENT_MODES.has(candidate)) return "agent";

  if (
    env.BRIDGE_PORT ||
    env.ELIZA_BRIDGE_PORT ||
    env.BRIDGE_SECRET ||
    env.ELIZA_CONTAINER_CLOUD === "1"
  ) {
    return "cloud-agent";
  }

  return "agent";
}

export function resolveContainerLaunch(env = process.env) {
  const mode = normalizeContainerMode(
    env.ELIZA_CONTAINER_MODE ?? env.ELIZA_AGENT_IMAGE_MODE,
    env,
  );
  const launchEnv = { ...env };

  if (mode === "cloud-agent") {
    if (!launchEnv.PORT) {
      launchEnv.PORT = launchEnv.ELIZA_PORT ?? "2138";
    }
    if (!launchEnv.BRIDGE_PORT) {
      launchEnv.BRIDGE_PORT = launchEnv.ELIZA_BRIDGE_PORT ?? "18790";
    }

    return {
      mode,
      command: process.execPath,
      args: ["--import", TSX_LOADER_PATH, "deploy/cloud-agent-entrypoint.ts"],
      env: launchEnv,
    };
  }

  return {
    mode,
    command: process.execPath,
    args: ["--import", TSX_LOADER_PATH, "eliza.mjs", "start"],
    env: launchEnv,
  };
}

export function spawnContainerProcess(spawnImpl = spawn, env = process.env) {
  const launch = resolveContainerLaunch(env);
  const child = spawnImpl(launch.command, launch.args, {
    stdio: "inherit",
    env: launch.env,
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }

  return { child, launch };
}

async function main() {
  const { child, launch } = spawnContainerProcess();
  console.log(`[container-entrypoint] mode=${launch.mode}`);

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error("[container-entrypoint] failed to spawn child process");
    console.error(error);
    process.exit(1);
  });
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void main();
}
