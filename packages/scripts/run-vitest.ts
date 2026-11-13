#!/usr/bin/env node
// Drives repo automation run vitest with explicit CLI and CI behavior.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTestRuntimeEnv,
  isCodexBundledNode,
  resolveExternalNode,
} from "./lib/test-runtime.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const vitestCli = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

function exitFromResult(result) {
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}

const env = buildTestRuntimeEnv(process.env, { repoRoot });
// Vitest is a Node.js lane. On Bun 1.4.2 sampled suites fail (uppercase `DATA:`
// URLs in fetch, http.Server.closeAllConnections, child Node ESM probes), so a
// launcher started by Bun hands Vitest to real Node and never falls back to Bun.
const launchedByBun = Boolean(process.versions.bun);
const nodePath = launchedByBun
  ? resolveExternalNode({ env, repoRoot, rejectBun: true })
  : isCodexBundledNode()
    ? resolveExternalNode({ env, repoRoot }) || process.execPath
    : process.execPath;

if (!nodePath) {
  console.error(
    [
      "[eliza-test] Vitest needs the Node.js version pinned in package.json engines.node.",
      "No Node.js executable was found on PATH, in nvm, or in Homebrew.",
      "Install it or set ELIZA_VITEST_NODE=/absolute/path/to/node.",
    ].join("\n"),
  );
  process.exit(1);
}

if (isCodexBundledNode() && nodePath === process.execPath) {
  console.error(
    [
      "[eliza-test] Vitest cannot run under the Codex.app bundled Node on macOS.",
      "Vite/Rolldown loads a native binding that macOS library validation rejects in that runtime.",
      "Install Node with nvm/Homebrew or set ELIZA_VITEST_NODE=/absolute/path/to/node.",
    ].join("\n"),
  );
  process.exit(1);
}

exitFromResult(
  spawnSync(nodePath, [vitestCli, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  }),
);
