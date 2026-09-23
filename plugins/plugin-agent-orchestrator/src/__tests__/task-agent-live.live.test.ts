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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

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
  await new Promise<void>((resolve, reject) => {
    const bunBinary = process.execPath;
    const child = spawn(
      bunBinary,
      [
        runNodeTsxScript,
        liveSmokeScript,
        "--framework",
        framework,
        "--mode",
        mode,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ORCHESTRATOR_LIVE: "1", PWD: repoRoot },
        stdio: "inherit",
      },
    );

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(
          new Error(
            `${framework} ${mode} live smoke exited via signal ${signal}`,
          ),
        );
        return;
      }
      try {
        assert.equal(
          code,
          0,
          `${framework} ${mode} live smoke exited with code ${code ?? -1}`,
        );
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
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
