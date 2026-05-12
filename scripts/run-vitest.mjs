#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildTestRuntimeEnv,
  isCodexBundledNode,
  resolveExternalNode,
} from "./lib/test-runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
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
const nodePath = isCodexBundledNode()
  ? resolveExternalNode({ env, repoRoot }) || process.execPath
  : process.execPath;

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
