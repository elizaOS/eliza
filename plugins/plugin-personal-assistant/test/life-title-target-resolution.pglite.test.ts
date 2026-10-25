/**
 * Real-PGlite proof that title targets resolve in tiers (exact, whole word,
 * substring) so a short target never lands on a word fragment of another
 * record, and that an ambiguous goal target asks instead of deleting.
 */

import type {
  ActionResult,
  AgentRuntime,
  HandlerCallback,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  resolveDefinitionFromIntent,
  runLifeOperationHandler,
} from "../src/actions/life.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;
let service: LifeOpsService;

async function invoke(
  params: Record<string, unknown>,
  text: string,
): Promise<ActionResult> {
  const message = {
    id: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: crypto.randomUUID() as UUID,
    content: { source: "autonomy", text },
  } as Memory;
  return runLifeOperationHandler(
    runtime,
    message,
    undefined,
    { parameters: params },
    vi.fn<HandlerCallback>(async () => []),
  );
}

async function createGoals(titles: string[]): Promise<void> {
  for (const title of titles) {
    await service.createGoal({
      title,
      description: title,
      cadence: { kind: "weekly" },
      supportStrategy: { approach: "weekly_review" },
      successCriteria: { summary: title, metric: "review_completed" },
      metadata: { source: "life-title-target-resolution" },
    });
  }
}

async function goalTitles(): Promise<string[]> {
  return (await service.listGoals()).map((entry) => entry.goal.title).sort();
}

async function clearGoals(): Promise<void> {
  for (const entry of await service.listGoals()) {
    await service.deleteGoal(entry.goal.id);
  }
}

function deleteGoal(target: string): Promise<ActionResult> {
  return invoke(
    { action: "delete", kind: "goal", target, intent: `Delete ${target}` },
    `Delete my ${target} goal`,
  );
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
  service = new LifeOpsService(runtime, { ownerEntityId: runtime.agentId });
}, 180_000);

beforeEach(clearGoals);

afterAll(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

describe("life title targets resolve by whole word before substring", () => {
  it("deletes the goal named by a whole word, not one containing it as a fragment", async () => {
    await createGoals([
      "Get ready for the marathon",
      "Read 12 books this year",
    ]);
    const result = await deleteGoal("read");
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(await goalTitles()).toEqual(["Get ready for the marathon"]);
  }, 120_000);

  it("asks which goal when a whole-word target names more than one", async () => {
    await createGoals(["Run a 5k", "Run a marathon"]);
    const result = await deleteGoal("run");
    expect(result.success).toBe(false);
    expect(result.text).toContain("Multiple items match");
    expect(result.text).toContain("Run a 5k");
    expect(result.text).toContain("Run a marathon");
    expect(await goalTitles()).toEqual(["Run a 5k", "Run a marathon"]);
  }, 120_000);

  it("resolves a definition by whole word over a fragment of another title", async () => {
    for (const title of ["Brunch with mom", "Morning run"]) {
      const created = await invoke(
        {
          action: "create",
          kind: "definition",
          title,
          intent: `Remind me about ${title}`,
          details: {
            confirmed: true,
            kind: "habit",
            cadence: { kind: "daily", windows: ["morning"] },
            timeZone: "UTC",
          },
        },
        `Remind me about ${title}`,
      );
      expect(created.success, JSON.stringify(created)).toBe(true);
    }
    const resolved = await resolveDefinitionFromIntent(
      service,
      "run",
      "Make the run reminder more persistent",
    );
    expect(resolved?.definition.title).toBe("Morning run");
  }, 120_000);

  it("still resolves a Korean title by its trailing word", async () => {
    await createGoals(["아침 달리기", "Read 12 books this year"]);
    const result = await deleteGoal("달리기");
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(await goalTitles()).toEqual(["Read 12 books this year"]);
  }, 120_000);
});
