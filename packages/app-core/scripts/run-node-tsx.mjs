#!/usr/bin/env node
/**
 * Launches a script under Node with the tsx loader, resolving the node binary
 * through run-node-runtime's candidate search (npm_node_execpath, PATH, common
 * install paths).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  parseRunNodeTsxArgs,
  signalChildProcessTree,
  startParentOrphanWatchdog,
} from "./lib/run-node-tsx-lifecycle.mjs";
import { resolveNodeExecPathFromCandidates } from "./run-node-runtime.mjs";

function resolveNodeCmd() {
  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) =>
      path.join(dir, process.platform === "win32" ? "node.exe" : "node"),
    );
  return resolveNodeExecPathFromCandidates({
    candidates: [
      process.env.npm_node_execpath,
      process.execPath,
      ...pathCandidates,
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ],
    explicitNodePath: process.env.ELIZA_NODE_PATH,
    platform: process.platform,
  });
}

const { childArgs: args, exitWithParent } = parseRunNodeTsxArgs(
  process.argv.slice(2),
);
if (args.length === 0) {
  console.error("[run-node-tsx] Missing script path");
  process.exit(1);
}

function withWorkspaceNodePath(env) {
  const rootModules = path.join(process.cwd(), "node_modules");
  const bunModules = path.join(rootModules, ".bun", "node_modules");
  const modulePaths = [rootModules, bunModules];
  return {
    ...env,
    NODE_PATH: env.NODE_PATH
      ? `${modulePaths.join(path.delimiter)}${path.delimiter}${env.NODE_PATH}`
      : modulePaths.join(path.delimiter),
    PWD: process.cwd(),
  };
}

const nodeArgs = [
  // WHY: this runner executes TypeScript workspace scripts before every
  // workspace package has a fresh dist build. Prefer source exports for
  // packages that declare the eliza-source condition, matching Vitest's
  // source-mode aliases and avoiding stale/missing dist imports in CI probes.
  "--conditions=eliza-source",
  "--import",
  "tsx",
  ...args,
];

const child = spawn(resolveNodeCmd(), nodeArgs, {
  cwd: process.cwd(),
  detached: exitWithParent && process.platform !== "win32",
  env: withWorkspaceNodePath(process.env),
  stdio: "inherit",
});

const SIGNAL_EXIT_CODE = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

let forwardedSignal = null;
let forceKillTimer = null;

function forwardSignal(signal) {
  forwardedSignal = signal;
  if (child.exitCode == null && child.signalCode == null) {
    if (exitWithParent) {
      signalChildProcessTree({ child, signal });
    } else {
      child.kill(signal);
    }
    forceKillTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        if (exitWithParent) {
          signalChildProcessTree({ child, signal: "SIGKILL" });
        } else {
          child.kill("SIGKILL");
        }
      }
    }, 10_000);
    forceKillTimer.unref?.();
  }
}

const parentWatchdog = exitWithParent
  ? startParentOrphanWatchdog({
      onOrphan: () => forwardSignal("SIGTERM"),
    })
  : null;

for (const signal of Object.keys(SIGNAL_EXIT_CODE)) {
  process.once(signal, () => forwardSignal(signal));
}

child.on("error", (error) => {
  parentWatchdog?.stop();
  console.error(
    `[run-node-tsx] Failed to spawn Node: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  parentWatchdog?.stop();
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }
  if (signal) {
    process.exit(SIGNAL_EXIT_CODE[signal] ?? 1);
  }
  if (forwardedSignal) {
    process.exit(SIGNAL_EXIT_CODE[forwardedSignal] ?? 1);
  }
  process.exit(code ?? 1);
});
