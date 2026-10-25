/**
 * KEYLESS end-to-end of app-creation-through-orchestration — NO LLM.
 *
 * The real {@link AcpService} spawns a deterministic FAKE ACP coding agent
 * (`__tests__/fixtures/fake-acp-agent.mjs`) that replays the "ideal"
 * Claude-Code/Codex session over the real ACP JSON-RPC protocol: it emits a
 * plan + tool-call updates and issues `fs/write_text_file` requests that the
 * ORCHESTRATOR executes into the workspace, then returns `end_turn` with a
 * consistent diff + test-runner completion. This proves the whole
 * spawn → prompt → tool → file-write → task_complete pipeline deterministically,
 * so app-creation orchestration is CI-testable without a live model.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";

const FAKE_AGENT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "__tests__",
  "fixtures",
  "fake-acp-agent.mjs",
);

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-0000keyless01",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: (k: string) => {
      if (k === "ELIZA_ACP_TRANSPORT") return "native";
      if (k === "ELIZA_ACP_DEFAULT_AGENT") return "elizaos";
      if (k === "ELIZA_ACP_NO_TERMINAL") return "true";
      if (k === "ELIZA_ELIZAOS_ACP_COMMAND") return `node ${FAKE_AGENT}`;
      return process.env[k as keyof typeof process.env] as string | undefined;
    },
  } as never;
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "e2e@test.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "e2e"], { cwd: dir });
}

describe("keyless app-creation e2e (fake ACP agent, no LLM)", () => {
  let workdir: string;
  let service: AcpService;
  let sessionId: string | undefined;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "keyless-app-e2e-"));
    gitInit(workdir);
    service = new AcpService(makeRuntime());
  });
  afterEach(async () => {
    if (sessionId) await service.closeSession(sessionId).catch(() => {});
    await service.stop().catch(() => {});
    rmSync(workdir, { recursive: true, force: true });
    sessionId = undefined;
  });

  it("spawns the agent, which builds a random-color app the orchestrator writes to disk, ending in task_complete", async () => {
    const events: string[] = [];
    service.onSessionEvent((_sid, name) => events.push(name));
    await service.start();

    const spawned = await service.spawnSession({
      agentType: "elizaos",
      workdir,
      approvalPreset: "permissive",
      timeoutMs: 60_000,
    });
    sessionId = spawned.sessionId;

    const result = await service.sendPrompt(
      sessionId,
      "Build a random-color web app with a button and a test",
      { timeoutMs: 60_000 },
    );

    // The orchestrator executed the agent's fs/write_text_file requests.
    expect(existsSync(join(workdir, "index.html"))).toBe(true);
    expect(existsSync(join(workdir, "app.js"))).toBe(true);
    expect(existsSync(join(workdir, "app.test.js"))).toBe(true);
    expect(readFileSync(join(workdir, "app.js"), "utf8")).toContain(
      "randomColor",
    );

    // The full orchestration event stream fired, ending in task_complete.
    expect(events).toContain("plan");
    expect(events).toContain("tool_running");
    expect(events).toContain("task_complete");
    expect(result.stopReason).toBe("end_turn");

    // The produced app is REAL: execute the test suite the agent wrote with
    // Node's own runner and assert on the runner's actual output — not on a
    // success string the fixture itself echoed back.
    const testRun = execFileSync(
      process.execPath,
      ["--test", "--test-reporter=tap", "app.test.js"],
      { cwd: workdir, encoding: "utf8" },
    );
    expect(testRun).toMatch(/# pass 2\b/);
    expect(testRun).toMatch(/# fail 0\b/);
  }, 90_000);
});
