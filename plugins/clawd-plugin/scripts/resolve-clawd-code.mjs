/**
 * Resolve the monorepo sibling clawd-code package for MCP and CLI bridges.
 * Preference order: CLAWD_CODE_BIN → sibling dist/src → workspace package → npx.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to plugins/clawd-plugin */
export const CLAWD_PLUGIN_ROOT = resolve(__dirname, "..");

/** Absolute path to plugins/clawd-code (git submodule of Solizardking/clawd-code) */
export const CLAWD_CODE_ROOT = resolve(CLAWD_PLUGIN_ROOT, "../clawd-code");

/** Canonical upstream source for the CLI package */
export const CLAWD_CODE_GITHUB = "https://github.com/Solizardking/clawd-code";

/**
 * @typedef {{
 *   kind: "bin" | "node" | "tsx" | "npx",
 *   path?: string,
 *   root?: string,
 *   package?: string,
 *   command: string,
 *   args: string[],
 * }} ClawdCodeResolution
 */

/**
 * Resolve how to invoke clawd-code from this plugin package.
 * @returns {ClawdCodeResolution}
 */
export function resolveClawdCode() {
  const envBin = process.env.CLAWD_CODE_BIN?.trim();
  if (envBin) {
    return {
      kind: "bin",
      path: envBin,
      root: CLAWD_CODE_ROOT,
      command: envBin,
      args: [],
    };
  }

  const siblingDist = join(CLAWD_CODE_ROOT, "dist", "cli.js");
  if (existsSync(siblingDist)) {
    return {
      kind: "node",
      path: siblingDist,
      root: CLAWD_CODE_ROOT,
      command: process.execPath,
      args: [siblingDist],
    };
  }

  const siblingSrc = join(CLAWD_CODE_ROOT, "src", "cli.ts");
  if (existsSync(siblingSrc)) {
    const tsxCli = join(CLAWD_CODE_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    if (existsSync(tsxCli)) {
      return {
        kind: "tsx",
        path: siblingSrc,
        root: CLAWD_CODE_ROOT,
        command: process.execPath,
        args: [tsxCli, siblingSrc],
      };
    }
    return {
      kind: "tsx",
      path: siblingSrc,
      root: CLAWD_CODE_ROOT,
      command: "npx",
      args: ["tsx", siblingSrc],
    };
  }

  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@solana-clawd/clawd-code/package.json");
    const pkgRoot = dirname(pkgJson);
    const distCli = join(pkgRoot, "dist", "cli.js");
    if (existsSync(distCli)) {
      return {
        kind: "node",
        path: distCli,
        root: pkgRoot,
        command: process.execPath,
        args: [distCli],
      };
    }
  } catch {
    // workspace package not resolvable yet
  }

  return {
    kind: "npx",
    package: "@solana-clawd/clawd-code@latest",
    command: "npx",
    args: ["@solana-clawd/clawd-code@latest"],
  };
}

/**
 * Plugin directory for `clawd --plugin-dir`.
 * Prefers this monorepo package; falls back to nested clawd-code/clawd-plugin.
 * @returns {string}
 */
export function resolveClawdPluginDir() {
  if (existsSync(join(CLAWD_PLUGIN_ROOT, ".mcp.json"))) {
    return CLAWD_PLUGIN_ROOT;
  }
  const nested = join(CLAWD_CODE_ROOT, "clawd-plugin");
  if (existsSync(nested)) {
    return nested;
  }
  return CLAWD_PLUGIN_ROOT;
}

/**
 * Paths used by Cheshire elizaOS packages that should stay aligned with clawd.
 * @returns {Record<string, string>}
 */
export function resolveCheshireBridgePaths() {
  return {
    clawdCodeGithub: CLAWD_CODE_GITHUB,
    clawdCodeRoot: CLAWD_CODE_ROOT,
    clawdPluginRoot: resolveClawdPluginDir(),
    cheshireEliza: resolve(CLAWD_PLUGIN_ROOT, "../../packages/cheshire-eliza"),
    pluginCheshireMemory: resolve(
      CLAWD_PLUGIN_ROOT,
      "../plugin-cheshire-memory",
    ),
    pluginClawdBrowser: resolve(CLAWD_PLUGIN_ROOT, "../plugin-clawdbrowser"),
  };
}

export function formatResolution(res = resolveClawdCode()) {
  return {
    kind: res.kind,
    command: res.command,
    args: res.args,
    path: res.path ?? null,
    root: res.root ?? null,
    package: res.package ?? null,
    pluginDir: resolveClawdPluginDir(),
    github: CLAWD_CODE_GITHUB,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(formatResolution(), null, 2));
}
