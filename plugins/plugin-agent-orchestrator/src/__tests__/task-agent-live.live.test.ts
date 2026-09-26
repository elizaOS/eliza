/**
 * Opt-in live smoke tests for real Claude Code and Codex sessions.
 *
 * These are skipped by default. Run with:
 *   ORCHESTRATOR_LIVE=1 bun run test -- src/__tests__/task-agent-live.live.test.ts
 *
 * Once enabled, unavailable authentication or agents fail the actual child flow.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { runOwnedChild } from "../../../../packages/scripts/plugins/plugin-agent-orchestrator/live-pi-linked-account.ts";

const RUN_LIVE = process.env.ORCHESTRATOR_LIVE === "1";
type Framework = "claude" | "codex";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const liveSmokeScript = path.join(
  repoRoot,
  "packages",
  "core",
  "test",
  "live",
  "task-agent-live-smoke.ts",
);

const liveDescribe = RUN_LIVE ? describe : describe.skip;

async function runLiveSmokeScript(framework: Framework): Promise<void> {
  const args = [
    "--conditions=eliza-source",
    "--import",
    "tsx",
    liveSmokeScript,
    "--framework",
    framework,
  ];
  const options = {
    cwd: repoRoot,
    env: {
      ...process.env,
      ORCHESTRATOR_LIVE: "1",
      // Session reuse requires the durable path; unit setup disables it.
      ELIZA_ORCHESTRATOR_SMITHERS: "1",
      PWD: repoRoot,
    },
    stdio: "inherit" as const,
  };
  // Leave time for owned teardown before Vitest's twelve-minute deadline.
  const timeout = 12 * 60 * 1000 - 10_000;
  let code: number | null;
  if (process.platform === "win32") {
    // Windows retains direct child supervision; POSIX group checks are not portable.
    const child = spawn(process.execPath, args, { ...options, timeout });
    const [exitCode, signal] = await once(child, "exit");
    assert.equal(signal, null, `${framework} live smoke was terminated`);
    code = exitCode;
  } else {
    ({ code } = await runOwnedChild(process.execPath, args, options, timeout));
  }
  assert.equal(code, 0, `${framework} live smoke exited with code ${code}`);
}

liveDescribe("task-agent live smoke (claude)", () => {
  it(
    "keeps a Claude Code session alive across sequential tracked tasks",
    async () => {
      await runLiveSmokeScript("claude");
    },
    12 * 60 * 1000,
  );
});

liveDescribe("task-agent live smoke (codex)", () => {
  it(
    "keeps a Codex session alive across sequential tracked tasks",
    async () => {
      await runLiveSmokeScript("codex");
    },
    12 * 60 * 1000,
  );
});
