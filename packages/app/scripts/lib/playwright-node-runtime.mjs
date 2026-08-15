/**
 * Resolves the Node.js runtime for the app Playwright lanes through the shared
 * app-core validator so an invalid ELIZA_NODE_PATH, a Bun executable, or a
 * pre-24 Node fails fast before Playwright or its webServer spawns. Consumed by
 * scripts/run-ui-playwright.mjs and the playwright.*.config.ts webServer
 * commands; candidate priority (explicit ELIZA_NODE_PATH → npm_node_execpath →
 * process.execPath → PATH node) matches the historical fail-open ladder, but
 * every candidate must now pass app-core's exists/executable/is-node/version
 * probe, and the error messages are the resolver's own contract strings.
 */
import fs from "node:fs";
import path from "node:path";
import {
  probeNodeExecutable,
  resolveNodeExecPathFromCandidates,
} from "../../../app-core/scripts/run-node-runtime.mjs";

/**
 * Finds an executable on PATH, honoring PATHEXT on Windows. Returns the first
 * existing absolute candidate or null when the command is not on PATH.
 */
export function resolveExecutableFromPath(
  command,
  env = process.env,
  platform = process.platform,
) {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (!pathValue) return null;

  const hasExtension = path.extname(command).length > 0;
  const pathExts =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim())
          .filter(Boolean)
      : [""];
  const binaryNames =
    platform === "win32" && !hasExtension
      ? pathExts.map((ext) => `${command}${ext.toLowerCase()}`)
      : [command];

  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const binaryName of binaryNames) {
      const candidate = path.join(dir, binaryName);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolves the validated Node.js executable for a Playwright lane. An explicit
 * env.ELIZA_NODE_PATH must validate or this throws app-core's
 * `Invalid ELIZA_NODE_PATH=...` contract; otherwise the first candidate that
 * probes as real Node.js 24+ wins, and exhaustion throws app-core's
 * `No usable Node.js 24+ executable found` contract.
 */
export function resolvePlaywrightNodeRuntime({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  probeNode = probeNodeExecutable,
} = {}) {
  const nodeCommand = platform === "win32" ? "node.exe" : "node";
  return resolveNodeExecPathFromCandidates({
    explicitNodePath: env.ELIZA_NODE_PATH,
    candidates: [
      env.npm_node_execpath?.trim(),
      execPath,
      resolveExecutableFromPath(nodeCommand, env, platform),
      nodeCommand,
    ],
    platform,
    probeNode,
  });
}
