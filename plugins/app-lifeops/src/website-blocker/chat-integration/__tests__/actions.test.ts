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

vi.mock("../../engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engine.js")>();
  return {
    ...actual,
    getSelfControlStatus: vi.fn(async () => defaultSelfControlStatus),
  };
});

// Bypass the OWNER access gate so the test exercises the subaction handlers
// without seeding world/role tables. `access.ts` transitively imports
// `@elizaos/agent`, which pulls in the broken `plugin-computeruse` package
// during test load — short-circuiting the gate avoids that import chain too.
vi.mock("../../access.js", () => ({
  SELFCONTROL_ACCESS_ERROR: "Website blocking is restricted to OWNER users.",
  getSelfControlAccess: vi.fn(async () => ({ allowed: true, role: "OWNER" })),
}));

import { websiteBlockAction } from "../../../actions/website-block.js";
import * as websiteBlockerEngine from "../../engine.js";
import { BlockRuleReader, BlockRuleWriter } from "../block-rule-service.js";
import {
  type BlockRuleTestHarness,
  createBlockRuleHarness,
} from "./test-harness.js";

const AGENT_ID = "00000000-0000-0000-0000-00000000cccc" as UUID;

// Use the agent's own id as `entityId` so the test message satisfies the
// owner gate `getSelfControlAccess` runs ahead of every WEBSITE_BLOCK
// subaction without forcing the harness to seed world/role tables.
const EMPTY_MESSAGE = {
  id: "00000000-0000-0000-0000-00000000ffff" as UUID,
  entityId: AGENT_ID,
  agentId: AGENT_ID,
  roomId: "00000000-0000-0000-0000-00000000eeee" as UUID,
  content: { text: "" },
} as Memory;

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

/**
 * W2-F: standalone `LIST_ACTIVE_BLOCKS` and `RELEASE_BLOCK` actions were folded
 * into `WEBSITE_BLOCK.{list_active, release}` subactions. The behavior tests
 * still exercise the same reader/writer plumbing through the unified entry.
 */
async function invokeSubaction(
  harness: BlockRuleTestHarness,
  subaction: "list_active" | "release",
  parameters: Record<string, unknown>,
): Promise<ActionResult> {
  const result = await websiteBlockAction.handler(
    harness.runtime,
    EMPTY_MESSAGE,
    undefined,
    {
      parameters: { subaction, ...parameters },
    } as HandlerOptions,
  );
  if (!isActionResult(result)) {
    throw new Error(`websiteBlockAction.${subaction} returned non-ActionResult`);
  }
  return result;
}

describe("WEBSITE_BLOCK list_active / release subactions", () => {
  let harness: BlockRuleTestHarness;

  beforeEach(async () => {
    harness = await createBlockRuleHarness(AGENT_ID);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.close();
  });

  it("list_active returns rules previously created by the writer", async () => {
    const writer = new BlockRuleWriter(harness.runtime);
    await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "fixed_duration",
      fixedDurationMs: 60_000,
    });
    const result = await invokeSubaction(harness, "list_active", {});
    const data = actionData(result);
    const rules = data.rules;
    expect(Array.isArray(rules)).toBe(true);
    expect((rules as unknown[]).length).toBe(1);
  });

  it("list_active includes live blocker status when no managed rules exist", async () => {
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

    const result = await invokeSubaction(harness, "list_active", {});

    expect(result.text ?? "").toContain(
      "A live website block is active for x.com until 2026-04-19T05:00:00.000Z.",
    );
    expect(result.text ?? "").toContain(
      "No managed website block rules are active.",
    );
    expect(actionData(result).rules).toEqual([]);
  });

  it("release without confirmed fails; harsh_no_bypass cannot be released", async () => {
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

    const unconfirmed = await invokeSubaction(harness, "release", {
      ruleId: normalId,
      confirmed: false,
    });
    expect(unconfirmed.success).toBe(false);

    const harshAttempt = await invokeSubaction(harness, "release", {
      ruleId: harshId,
      confirmed: true,
    });
    expect(harshAttempt.success).toBe(false);
    expect(harshAttempt.text ?? "").toMatch(/harsh_no_bypass/);

    const ok = await invokeSubaction(harness, "release", {
      ruleId: normalId,
      confirmed: true,
      reason: "done",
    });
    expect(ok.success).toBe(true);
    const reader = new BlockRuleReader(harness.runtime);
    const released = await reader.getBlockRuleById(normalId);
    expect(released?.active).toBe(false);
    expect(released?.releasedReason).toBe("done");
  });
});
