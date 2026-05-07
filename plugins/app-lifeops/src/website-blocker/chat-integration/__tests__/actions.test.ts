import type { ActionResult, HandlerOptions, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { defaultSelfControlStatus } = vi.hoisted(() => ({
  defaultSelfControlStatus: {
    available: true,
    active: false,
    hostsFilePath: "/tmp/test-hosts",
    startedAt: null,
    endsAt: null,
    websites: [],
    managedBy: null,
    metadata: null,
    scheduledByAgentId: null,
    canUnblockEarly: true,
    requiresElevation: false,
    engine: "hosts-file" as const,
    platform: process.platform,
    supportsElevationPrompt: false,
    elevationPromptMethod: null,
  },
}));

vi.mock("../../../actions/website-block.js", () => ({
  websiteBlockAction: {
    handler: vi.fn(async () => ({
      success: true,
      text: "Website block side effect mocked for chat integration tests.",
    })),
  },
}));

vi.mock("../../engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engine.js")>();
  return {
    ...actual,
    getSelfControlStatus: vi.fn(async () => defaultSelfControlStatus),
  };
});

import * as websiteBlockerEngine from "../../engine.js";
import { blockUntilTaskCompleteAction } from "../actions/blockUntilTaskComplete.js";
import { listActiveBlocksAction } from "../actions/listActiveBlocks.js";
import { releaseBlockAction } from "../actions/releaseBlock.js";
import { BlockRuleReader, BlockRuleWriter } from "../block-rule-service.js";
import {
  type BlockRuleTestHarness,
  createBlockRuleHarness,
  seedTodo,
} from "./test-harness.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000cccc" as UUID;

const EMPTY_MESSAGE = {
  id: "00000000-0000-0000-0000-00000000ffff" as UUID,
  entityId: "00000000-0000-0000-0000-00000000dddd" as UUID,
  agentId: AGENT_ID,
  roomId: "00000000-0000-0000-0000-00000000eeee" as UUID,
  content: { text: "" },
} as unknown as Memory;

function isActionResult(value: unknown): value is ActionResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in (value as Record<string, unknown>)
  );
}

function actionData(result: unknown): Record<string, unknown> {
  if (
    isActionResult(result) &&
    result.data &&
    typeof result.data === "object"
  ) {
    return result.data as Record<string, unknown>;
  }
  return {};
}

describe("T7g actions", () => {
  let harness: BlockRuleTestHarness;

  beforeEach(async () => {
    harness = await createBlockRuleHarness(AGENT_ID);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.close();
  });

  it("BLOCK_UNTIL_TASK_COMPLETE with todoName (no match) creates a new todo AND a block rule", async () => {
    const options = {
      parameters: {
        websites: ["x.com"],
        todoName: "Finish workout",
      },
    } as HandlerOptions;

    const result = await blockUntilTaskCompleteAction.handler(
      harness.runtime,
      EMPTY_MESSAGE,
      undefined,
      options,
    );

    expect(isActionResult(result)).toBe(true);
    const data = actionData(result);
    expect(data.createdTodo).toBe(true);
    const todoId = data.todoId;
    expect(typeof todoId).toBe("string");
    const ruleId = data.ruleId;
    expect(typeof ruleId).toBe("string");

    const reader = new BlockRuleReader(harness.runtime);
    const gated = await reader.findBlocksGatedByTodo(String(todoId));
    expect(gated).toHaveLength(1);
    expect(gated[0].id).toBe(ruleId);
    expect(gated[0].websites).toEqual(["x.com"]);
  });

  it("BLOCK_UNTIL_TASK_COMPLETE with todoName matching an existing todo reuses it", async () => {
    await seedTodo(harness, { id: "todo-existing", title: "Daily workout" });
    const options = {
      parameters: {
        websites: ["x.com"],
        todoName: "workout",
      },
    } as HandlerOptions;

    const result = await blockUntilTaskCompleteAction.handler(
      harness.runtime,
      EMPTY_MESSAGE,
      undefined,
      options,
    );
    const data = actionData(result);
    expect(data.createdTodo).toBe(false);
    expect(data.todoId).toBe("todo-existing");
  });

  it("LIST_ACTIVE_BLOCKS returns rules previously created by the writer", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "fixed_duration",
      fixedDurationMs: 60_000,
    });
    const result = await listActiveBlocksAction.handler(
      harness.runtime,
      EMPTY_MESSAGE,
      undefined,
      undefined,
    );
    const data = actionData(result);
    const rules = data.rules;
    expect(Array.isArray(rules)).toBe(true);
    expect((rules as unknown[]).length).toBe(1);
  });

  it("LIST_ACTIVE_BLOCKS includes live blocker status when no managed rules exist", async () => {
    vi.spyOn(websiteBlockerEngine, "getSelfControlStatus").mockResolvedValue({
      available: true,
      active: true,
      hostsFilePath: "/etc/hosts",
      startedAt: "2026-04-19T03:00:00.000Z",
      endsAt: "2026-04-19T05:00:00.000Z",
      websites: ["x.com"],
      managedBy: "eliza-selfcontrol",
      metadata: null,
      scheduledByAgentId: null,
      canUnblockEarly: true,
      requiresElevation: false,
      engine: "hosts-file",
      platform: process.platform,
      supportsElevationPrompt: false,
      elevationPromptMethod: null,
    });

    const result = await listActiveBlocksAction.handler(
      harness.runtime,
      EMPTY_MESSAGE,
      undefined,
      undefined,
    );

    expect((result as ActionResult).text ?? "").toContain(
      "A live website block is active for x.com until 2026-04-19T05:00:00.000Z.",
    );
    expect((result as ActionResult).text ?? "").toContain(
      "No managed website block rules are active.",
    );
    expect(actionData(result).rules).toEqual([]);
  });

  it("BLOCK_UNTIL_TASK_COMPLETE validate rejects fixed-duration-only prompts", async () => {
    const shouldValidate = await blockUntilTaskCompleteAction.validate?.(
      harness.runtime,
      {
        ...EMPTY_MESSAGE,
        content: {
          text: "Block x.com for 2 hours so I can focus.",
        },
      } as Memory,
    );

    expect(shouldValidate).toBe(false);
  });

  it("RELEASE_BLOCK without confirmed fails; harsh_no_bypass cannot be released", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    const normalId = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-1",
    });
    const harshId = await writer.createBlockRule({
      profile: "harsh",
      websites: ["x.com"],
      gateType: "harsh_no_bypass",
      gateTodoId: "todo-h",
    });

    const unconfirmed = await releaseBlockAction.handler(
      harness.runtime,
      EMPTY_MESSAGE,
      undefined,
      { parameters: { ruleId: normalId, confirmed: false } } as HandlerOptions,
    );
    expect(isActionResult(unconfirmed)).toBe(true);
    expect((unconfirmed as ActionResult).success).toBe(false);

    const harshAttempt = await releaseBlockAction.handler(
      harness.runtime,
      EMPTY_MESSAGE,
      undefined,
      { parameters: { ruleId: harshId, confirmed: true } } as HandlerOptions,
    );
    expect((harshAttempt as ActionResult).success).toBe(false);
    expect((harshAttempt as ActionResult).text ?? "").toMatch(
      /harsh_no_bypass/,
    );

    const ok = await releaseBlockAction.handler(
      harness.runtime,
      EMPTY_MESSAGE,
      undefined,
      {
        parameters: { ruleId: normalId, confirmed: true, reason: "done" },
      } as HandlerOptions,
    );
    expect((ok as ActionResult).success).toBe(true);
    const reader = new BlockRuleReader(harness.runtime);
    const released = await reader.getBlockRuleById(normalId);
    expect(released?.active).toBe(false);
    expect(released?.releasedReason).toBe("done");
  });
});
