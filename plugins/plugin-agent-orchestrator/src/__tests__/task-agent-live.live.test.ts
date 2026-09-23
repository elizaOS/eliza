/**
 * Opt-in live smoke tests for real Claude Code and Codex sessions.
 *
 * These are skipped by default. Run with:
 *   ORCHESTRATOR_LIVE=1 bun run test -- src/__tests__/task-agent-live.live.test.ts
 *
 * Browser-heavy web smoke tests additionally require ORCHESTRATOR_LIVE_WEB=1.
 * Once enabled, unavailable authentication or agents fail the actual child flow.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { runOwnedChild } from "../../scripts/live-pi-linked-account.mjs";

const RUN_LIVE = process.env.ORCHESTRATOR_LIVE === "1";
const RUN_WEB_LIVE = process.env.ORCHESTRATOR_LIVE_WEB === "1";
type Framework = "claude" | "codex";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const runNodeTsxScript = path.join(
  repoRoot,
  "packages",
  "app-core",
  "scripts",
  "run-node-tsx.mjs",
);
const liveSmokeScript = path.join(
  repoRoot,
  "packages",
  "core",
  "test",
  "live",
  "task-agent-live-smoke.ts",
);

const liveDescribe = RUN_LIVE ? describe : describe.skip;
const webLiveIt = RUN_WEB_LIVE ? it : it.skip;

async function runLiveSmokeScript(
  framework: Framework,
  mode: "sequential" | "web",
): Promise<void> {
  const args = [
    runNodeTsxScript,
    liveSmokeScript,
    "--framework",
    framework,
    "--mode",
    mode,
  ];
  const options = {
    cwd: repoRoot,
    env: { ...process.env, ORCHESTRATOR_LIVE: "1", PWD: repoRoot },
    stdio: "inherit" as const,
  };
  // Leave time for owned teardown before Vitest's twelve-minute deadline.
  const timeout = 12 * 60 * 1000 - 10_000;
  let code: number | null;
  if (process.platform === "win32") {
    // Windows retains direct child supervision; POSIX group checks are not portable.
    const child = spawn(process.execPath, args, { ...options, timeout });
    const [exitCode, signal] = await once(child, "exit");
    assert.equal(
      signal,
      null,
      `${framework} ${mode} live smoke was terminated`,
    );
    code = exitCode;
  } else {
    ({ code } = await runOwnedChild(process.execPath, args, options, timeout));
  }
  assert.equal(
    code,
    0,
    `${framework} ${mode} live smoke exited with code ${code}`,
  );
}

liveDescribe("task-agent live smoke (claude)", () => {
  it(
    "keeps a Claude Code session alive across sequential tracked tasks",
    async () => {
      await runLiveSmokeScript("claude", "sequential");
    },
    12 * 60 * 1000,
  );

  webLiveIt(
    "has Claude Code research a page and serve a generated webpage",
    async () => {
      await runLiveSmokeScript("claude", "web");
    },
    12 * 60 * 1000,
  );
});

liveDescribe("task-agent live smoke (codex)", () => {
  it(
    "keeps a Codex session alive across sequential tracked tasks",
    async () => {
      await runLiveSmokeScript("codex", "sequential");
    },
    12 * 60 * 1000,
  );

  webLiveIt(
    "has Codex research a page and serve a generated webpage",
    async () => {
      await runLiveSmokeScript("codex", "web");
    },
    12 * 60 * 1000,
  );
});
