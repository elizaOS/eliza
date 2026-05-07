import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../actions/owner-website-block.js", () => ({
  ownerWebsiteBlockAction: {
    handler: vi.fn(async () => ({
      success: true,
      text: "Website block side effect mocked for block rule reconciler tests.",
    })),
  },
}));

import { reconcileBlockRulesOnce } from "../block-rule-reconciler.js";
import { BlockRuleReader, BlockRuleWriter } from "../block-rule-service.js";
import {
  type BlockRuleTestHarness,
  completeTodo,
  createBlockRuleHarness,
  seedTodo,
} from "./test-harness.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000bbbb" as UUID;

describe("BlockRuleReconciler", () => {
  let harness: BlockRuleTestHarness;

  beforeEach(async () => {
    harness = await createBlockRuleHarness(AGENT_ID);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("releases until_todo rules when the gate todo is completed", async () => {
    await seedTodo(harness, { id: "todo-workout", title: "Workout" });
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);

    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-workout",
    });

    await reconcileBlockRulesOnce(harness.runtime);
    let rule = await reader.getBlockRuleById(id);
    expect(rule?.active).toBe(true);

    await completeTodo(harness, "todo-workout");
    await reconcileBlockRulesOnce(harness.runtime);

    rule = await reader.getBlockRuleById(id);
    expect(rule?.active).toBe(false);
    expect(rule?.releasedReason).toBe("todo_completed");
  });

  it("schedules auto re-lock when unlock_duration_ms is set and gate fulfills", async () => {
    await seedTodo(harness, { id: "todo-break", title: "Take a break" });
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);

    const unlockMs = 15 * 60_000;
    const originalId = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-break",
      unlockDurationMs: unlockMs,
    });

    await completeTodo(harness, "todo-break");
    const before = Date.now();
    await reconcileBlockRulesOnce(harness.runtime);
    const after = Date.now();

    const original = await reader.getBlockRuleById(originalId);
    expect(original?.active).toBe(false);

    const active = await reader.listActiveBlocks();
    expect(active).toHaveLength(1);
    expect(active[0].gateType).toBe("until_iso");
    expect(active[0].websites).toEqual(["x.com"]);
    expect(active[0].gateUntilMs).not.toBeNull();
    expect(active[0].gateUntilMs!).toBeGreaterThanOrEqual(before + unlockMs);
    expect(active[0].gateUntilMs!).toBeLessThanOrEqual(after + unlockMs + 50);
  });

  it("harsh_no_bypass release only fires when the gate todo completes", async () => {
    await seedTodo(harness, { id: "todo-hard", title: "Hard work" });
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);

    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "harsh_no_bypass",
      gateTodoId: "todo-hard",
    });

    await reconcileBlockRulesOnce(harness.runtime);
    expect((await reader.getBlockRuleById(id))?.active).toBe(true);

    await expect(
      writer.releaseBlockRule(id, { confirmed: true }),
    ).rejects.toThrow(/harsh_no_bypass/);
    expect((await reader.getBlockRuleById(id))?.active).toBe(true);

    await completeTodo(harness, "todo-hard");
    await reconcileBlockRulesOnce(harness.runtime);
    const released = await reader.getBlockRuleById(id);
    expect(released?.active).toBe(false);
    expect(released?.releasedReason).toBe("todo_completed");
  });

  it("fixed_duration releases only once the duration has elapsed", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);

    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "fixed_duration",
      fixedDurationMs: 1000,
    });
    const rule = await reader.getBlockRuleById(id);
    expect(rule).not.toBeNull();
    const createdAt = rule!.createdAt;

    // Before the duration elapses: stays active
    await reconcileBlockRulesOnce(harness.runtime, createdAt + 500);
    expect((await reader.getBlockRuleById(id))?.active).toBe(true);

    // After the duration elapses: released
    await reconcileBlockRulesOnce(harness.runtime, createdAt + 2000);
    const after = await reader.getBlockRuleById(id);
    expect(after?.active).toBe(false);
    expect(after?.releasedReason).toBe("fixed_duration_elapsed");
  });

  it("until_iso releases only once the target time has passed", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);
    const nowMs = Date.now();
    const target = nowMs + 60_000;
    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_iso",
      gateUntilMs: target,
    });

    await reconcileBlockRulesOnce(harness.runtime, target - 1);
    expect((await reader.getBlockRuleById(id))?.active).toBe(true);

    await reconcileBlockRulesOnce(harness.runtime, target + 1);
    const after = await reader.getBlockRuleById(id);
    expect(after?.active).toBe(false);
    expect(after?.releasedReason).toBe("until_iso_reached");
  });
});
