import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../block-activator.js", () => ({
  activateBlockRule: vi.fn(async () => ({
    success: true,
    endsAt: null,
  })),
}));

import { BlockRuleReader, BlockRuleWriter } from "../block-rule-service.js";
import {
  type BlockRuleTestHarness,
  createBlockRuleHarness,
} from "./test-harness.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000aaaa" as UUID;

describe("BlockRuleWriter + BlockRuleReader", () => {
  let harness: BlockRuleTestHarness;

  beforeEach(async () => {
    harness = await createBlockRuleHarness(AGENT_ID);
  });

  afterEach(async () => {
    await harness.close();
  });

  it("createBlockRule persists a fixed_duration rule and listActiveBlocks returns it", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);

    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com", "twitter.com"],
      gateType: "fixed_duration",
      fixedDurationMs: 60_000,
    });

    const rules = await reader.listActiveBlocks();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe(id);
    expect(rules[0].gateType).toBe("fixed_duration");
    expect(rules[0].websites).toEqual(["x.com", "twitter.com"]);
    expect(rules[0].fixedDurationMs).toBe(60_000);
    expect(rules[0].active).toBe(true);
  });

  it("createBlockRule with until_todo stores gate_todo_id and is findable by todo id", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);

    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-42",
    });

    const gated = await reader.findBlocksGatedByTodo("todo-42");
    expect(gated).toHaveLength(1);
    expect(gated[0].id).toBe(id);
    expect(gated[0].gateTodoId).toBe("todo-42");
  });

  it("releaseBlockRule refuses when confirmed is false", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-1",
    });
    await expect(
      writer.releaseBlockRule(id, { confirmed: false }),
    ).rejects.toThrow(/confirmed:true/);
  });

  it("releaseBlockRule with harsh_no_bypass cannot be released even when confirmed", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "harsh_no_bypass",
      gateTodoId: "todo-1",
    });
    await expect(
      writer.releaseBlockRule(id, {
        confirmed: true,
        reason: "I really want to bypass",
      }),
    ).rejects.toThrow(/harsh_no_bypass/);
  });

  it("releaseBlockRule with confirmed:true releases a non-harsh rule", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);
    const id = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-1",
    });
    await writer.releaseBlockRule(id, {
      confirmed: true,
      reason: "changed-my-mind",
    });
    const active = await reader.listActiveBlocks();
    expect(active).toHaveLength(0);
    const rule = await reader.getBlockRuleById(id);
    expect(rule?.active).toBe(false);
    expect(rule?.releasedReason).toBe("changed-my-mind");
  });

  it("isBlockActive returns true only for active rules matching the profile", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const reader = new BlockRuleReader(harness.runtime);
    const id = await writer.createBlockRule({
      profile: "deep-focus",
      websites: ["x.com"],
      gateType: "fixed_duration",
      fixedDurationMs: 60_000,
    });
    expect(await reader.isBlockActive("deep-focus")).toBe(true);
    expect(await reader.isBlockActive("other")).toBe(false);
    await writer.releaseBlockRule(id, { confirmed: true });
    expect(await reader.isBlockActive("deep-focus")).toBe(false);
  });
});
