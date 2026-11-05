/**
 * Real-PGlite proof that a goal whose title or description contains U+0000 is
 * stored. The goals repository writes through plugin-sql's raw-SQL literals,
 * where a raw NUL truncated the statement ("insufficient data left in
 * message") and the goal was never saved.
 */
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import { goalsDbSchema } from "../src/db/schema.ts";
import { createOwnerGoalsService } from "../src/goals-runtime.ts";
import type { GoalsService } from "../src/goals-service.ts";

const NUL = String.fromCharCode(0);

const goalsSchemaPlugin: Plugin = {
  name: "goals-nul-text-real-db-schema",
  description: "Test-only goals table bootstrap.",
  schema: goalsDbSchema,
};

describe("Goal text with U+0000 — real PGlite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: GoalsService;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "goals-nul-text-real-db",
      plugins: [goalsSchemaPlugin],
    });
    runtime = testResult.runtime;
    service = createOwnerGoalsService(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("creates a goal whose title and description contain U+0000", async () => {
    const created = await service.createGoal({
      title: `Run${NUL} a marathon`,
      description: `Train${NUL} every week`,
    });
    // The row is stored, and read back without U+0000.
    const stored = await service.getGoal(created.goal.id);
    expect(stored.goal.title).toBe("Run a marathon");
    expect(stored.goal.description).toBe("Train every week");
  });
});
