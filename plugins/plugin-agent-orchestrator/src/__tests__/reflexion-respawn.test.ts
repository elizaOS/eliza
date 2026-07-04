/**
 * Service-level proof for #8899 AC#3 (inject prior failure into the re-spawn
 * prompt): drive the REAL `spawnAgentForTask` read-at-spawn path
 * (orchestrator-task-service.ts ~L2242) — not the pure render leaf — so a
 * failed verification's reflection provably reaches the SECOND sub-agent's goal
 * prompt, including coercion of malformed persisted entries.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGrillingRuntime } from "../../test/scenarios/_helpers/orchestrator-grilling-harness.ts";
import {
  driveReflexionRespawn,
  makeSpawnCapturingAcp,
  REFLEXION_FAIL_SUMMARY,
  REFLEXION_MISSING_CRITERION,
  reflexionVerifierModel,
  runReflexionRespawnCheck,
  seedReflexionTask,
} from "../../test/scenarios/_helpers/reflexion-scenario.ts";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";

function makeBaseRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Tester" },
    databaseAdapter: undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getSetting: () => undefined,
    getService: () => undefined,
    useModel: async () => "{}",
  } as never;
}

describe("reflexion re-spawn injection (#8899)", () => {
  let savedFlag: string | undefined;
  beforeEach(() => {
    savedFlag = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  });
  afterEach(() => {
    if (savedFlag === undefined)
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = savedFlag;
  });

  it("carries the first failed attempt's reflection into the re-spawn prompt", async () => {
    const trace = await driveReflexionRespawn(
      makeBaseRuntime(),
      reflexionVerifierModel,
    );

    // Clean first spawn: no past failures.
    expect(trace.firstPrompt).not.toContain("Past Attempt Failures");

    // The real append produced exactly attempt 1 from the verifier verdict.
    expect(trace.reflectionsAfterFail).toEqual([
      {
        attempt: 1,
        summary: REFLEXION_FAIL_SUMMARY,
        missing: [REFLEXION_MISSING_CRITERION],
      },
    ]);

    // Re-spawn prompt (the string actually sent to ACP) replays it.
    expect(trace.respawnPrompt).toContain("--- Past Attempt Failures ---");
    expect(trace.respawnPrompt).toContain(
      `Attempt 1: ${REFLEXION_FAIL_SUMMARY}`,
    );
    expect(trace.respawnPrompt).toContain(
      `Missing: ${REFLEXION_MISSING_CRITERION}.`,
    );

    // And the value persisted on the new session row matches (DB round-trip).
    expect(trace.persistedRespawnGoalPrompt).toContain(
      `Attempt 1: ${REFLEXION_FAIL_SUMMARY}`,
    );
  });

  it("passes the scenario check that the second prompt contains the first reflection", async () => {
    expect(
      await runReflexionRespawnCheck(makeBaseRuntime(), reflexionVerifierModel),
    ).toBeUndefined();
  });

  it("coerces malformed persisted reflections on the read-at-spawn path", async () => {
    const { store, taskId } = await seedReflexionTask([
      REFLEXION_MISSING_CRITERION,
    ]);
    // Seed prior reflections with malformed neighbours that must be dropped, and
    // a non-string entry inside `missing` that must be filtered.
    await store.updateTask(taskId, {
      metadata: {
        attemptReflections: [
          { not: "valid" },
          "garbage",
          {
            attempt: 2,
            summary: "prior real failure",
            missing: [REFLEXION_MISSING_CRITERION, 7],
          },
        ],
      },
    });
    const acp = makeSpawnCapturingAcp();
    const service = new OrchestratorTaskService(
      makeGrillingRuntime(
        makeBaseRuntime(),
        acp.service,
        reflexionVerifierModel,
      ),
      { store },
    );
    await service.start();
    try {
      await service.spawnAgentForTask(taskId);
    } finally {
      await service.stop().catch(() => undefined);
    }

    const prompt = acp.spawns.at(0)?.initialTask ?? "";
    expect(prompt).toContain("--- Past Attempt Failures ---");
    // Only the one well-formed entry renders, with the non-string criterion gone.
    expect(prompt).toContain("Attempt 2: prior real failure");
    expect(prompt).toContain(`Missing: ${REFLEXION_MISSING_CRITERION}.`);
    expect(prompt).not.toContain("Attempt 1");
    expect(prompt).not.toContain("garbage");
  });

  it("captures a before/after spawn-prompt pair for evidence", async () => {
    const trace = await driveReflexionRespawn(
      makeBaseRuntime(),
      reflexionVerifierModel,
    );
    expect(trace.firstPrompt).not.toContain("Past Attempt Failures");
    expect(trace.respawnPrompt).toContain("Past Attempt Failures");

    // Dump the pair only when an evidence dir is requested, so CI stays read-only
    // while a maintainer can regenerate .github/issue-evidence/8899-… on demand:
    //   ORCH_8899_EVIDENCE_DIR=.github/issue-evidence/8899-reflexion-respawn \
    //     bunx vitest run … reflexion-respawn
    const evidenceDir = process.env.ORCH_8899_EVIDENCE_DIR;
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      const markdown = [
        "# #8899 — re-spawn goal-prompt before/after (real test capture)",
        "",
        "Captured by `reflexion-respawn.test.ts` driving the real",
        "`spawnAgentForTask` path. The BEFORE prompt is the first spawn (no",
        "failures yet); the AFTER prompt is the re-spawn following one failed",
        "automatic verification — note the injected `--- Past Attempt Failures ---`",
        "section replaying attempt 1.",
        "",
        "## BEFORE — first spawn (clean)",
        "",
        "```text",
        trace.firstPrompt,
        "```",
        "",
        "## AFTER — re-spawn (reflection injected)",
        "",
        "```text",
        trace.respawnPrompt,
        "```",
        "",
      ].join("\n");
      writeFileSync(join(evidenceDir, "004-prompt-before-after.md"), markdown);
    }
  });
});
