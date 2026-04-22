/**
 * Resolve how to spawn the local n8n sidecar child process.
 *
 * Prefer `npx --yes n8n@<pin>` when `npx` exists. If the user refuses to rely
 * on global `npx`, fall back to the workspace-installed `n8n` CLI executed with
 * `node` (still Node — never `bunx`, which breaks n8n's CJS loader).
 */

import { createRequire } from "node:module";

import {
  formatPackageRunnerInstallHint,
  N8N_DEFAULT_PACKAGE_LAUNCHER,
} from "../utils/package-runner-on-path.js";

export { N8N_DEFAULT_PACKAGE_LAUNCHER };

const require = createRequire(import.meta.url);

export interface N8nChildLaunch {
  /** argv[0] for child_process.spawn */
  command: string;
  /** argv.slice(1) */
  args: string[];
  /** Short label for logs */
  label: string;
}

/**
 * Returns absolute path to the n8n CLI shipped in this workspace's
 * `node_modules`, or null if `n8n` is not installed (optional dep skipped, etc.).
 */
export function resolveBundledN8nCliPath(): string | null {
  try {
    return require.resolve("n8n/bin/n8n");
  } catch {
    return null;
  }
}

function launchFromExplicitLauncher(
  launcher: string,
  pinnedVersion: string,
): N8nChildLaunch {
  const versioned = `n8n@${pinnedVersion}`;
  const binaryBase = launcher.split("/").pop() ?? launcher;
  if (binaryBase === "npx") {
    return {
      command: launcher,
      args: ["--yes", versioned, "start"],
      label: "npx",
    };
  }
  if (binaryBase === "bunx") {
    return {
      command: launcher,
      args: ["--", versioned, "start"],
      label: "bunx",
    };
  }
  return {
    command: launcher,
    args: [versioned, "start"],
    label: binaryBase,
  };
}

export interface ResolveN8nChildLaunchOptions {
  configuredBinary: string;
  pinnedVersion: string;
  probe: (binary: string) => Promise<boolean>;
}

/**
 * Resolve argv for spawning n8n. Default binary {@link N8N_DEFAULT_PACKAGE_LAUNCHER}:
 * try `npx`, then `node` + bundled `n8n` from optional dependency.
 */
export async function resolveN8nChildLaunch(
  opts: ResolveN8nChildLaunchOptions,
): Promise<N8nChildLaunch> {
  const trimmed = opts.configuredBinary.trim();
  if (trimmed !== N8N_DEFAULT_PACKAGE_LAUNCHER) {
    return launchFromExplicitLauncher(trimmed, opts.pinnedVersion);
  }

  if (await opts.probe("npx")) {
    return launchFromExplicitLauncher("npx", opts.pinnedVersion);
  }

  const bundledCli = resolveBundledN8nCliPath();
  if (bundledCli && (await opts.probe("node"))) {
    return {
      command: "node",
      args: [bundledCli, "start"],
      label: "node+bundled-n8n",
    };
  }

  const parts: string[] = [
    "Local n8n needs either `npx` on PATH, or `node` plus the `n8n` package installed in this workspace.",
  ];
  if (!bundledCli) {
    parts.push(
      "Bundled n8n was not found (optional `n8n` dependency missing — run `bun install` at the repo root).",
    );
  } else {
    parts.push(
      "`node` is not on PATH — n8n cannot run under Bun alone. Install Node or add `node` to PATH.",
    );
  }
  parts.push(formatPackageRunnerInstallHint("npx"));
  throw new Error(parts.join(" "));
}
