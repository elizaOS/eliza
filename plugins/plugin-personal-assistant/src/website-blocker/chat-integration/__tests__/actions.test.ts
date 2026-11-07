/**
 * Tests the BLOCK website-target subaction handlers against the real SelfControl
 * engine backed by the harness temp hosts file, with the OWNER access gate
 * bypassed so handlers run without seeding world/role tables.
 */

import type { ActionResult, HandlerOptions, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bypass the OWNER access gate so the test exercises the subaction handlers
// without seeding world/role tables. `getSelfControlStatus` stays a spyable
// vi.fn but delegates to the real engine (backed by the harness scratch hosts
// file) so the writer's OS-state sync sees the truth; the live-status
// formatting test pins its own status via `vi.spyOn(...).mockResolvedValue`.
vi.mock(
  "@elizaos/plugin-blocker/services/website-blocker/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@elizaos/plugin-blocker/services/website-blocker/index")
      >();
    return {
      ...actual,
      getSelfControlStatus: vi.fn(async () => actual.getSelfControlStatus()),
      SELFCONTROL_ACCESS_ERROR:
        "Website blocking is restricted to OWNER users.",
      getSelfControlAccess: vi.fn(async () => ({
        allowed: true,
        role: "OWNER",
      })),
    };
  },
);

// Audit B Defer #1 folded `WEBSITE_BLOCK` into the `BLOCK` umbrella; exercise
// the website-target handler directly so this test covers the reader/writer
// dispatch without re-registering the retired standalone action.
import * as websiteBlockerEngine from "@elizaos/plugin-blocker/services/website-blocker/index";
import { runWebsiteBlockHandler } from "../../../actions/website-block.js";
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
  subaction: "block" | "list_active" | "release",
  parameters: Record<string, unknown>,
  message: Memory = EMPTY_MESSAGE,
): Promise<ActionResult> {
  const result = await runWebsiteBlockHandler(
    harness.runtime,
    message,
    undefined,
    {
      parameters: { subaction, ...parameters },
    } as HandlerOptions,
  );
  if (!isActionResult(result)) {
    throw new Error(
      `websiteBlockAction.${subaction} returned non-ActionResult`,
    );
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
    // `getSelfControlStatus` in the factory mock is a shared vi.fn;
    // `vi.restoreAllMocks()` does not restore a factory-created mock, so a
    // persistent mockResolvedValue here would leak this pinned "foreign
    // /etc/hosts block" into subsequent tests and make the writer's OS sync refuse
    // to engage. Pin exactly the one status read this subaction performs.
    vi.spyOn(
      websiteBlockerEngine,
      "getSelfControlStatus",
    ).mockResolvedValueOnce({
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

  it("block with explicit hostnames and no intent drafts the confirmation prompt", async () => {
    const draft = await invokeSubaction(harness, "block", {
      hostnames: ["x.com"],
      durationMinutes: 120,
    });
    expect(draft.success).toBe(true);
    expect(draft.text).toBe(
      "Ready to block x.com for 120 minutes. Reply yes to confirm or no to cancel.",
    );
    expect(actionData(draft).requiresConfirmation).toBe(true);
  });

  it("block keeps every supplied hostname when the message names only some of them", async () => {
    const draft = await invokeSubaction(
      harness,
      "block",
      {
        hostnames: ["x.com", "twitter.com", "news.ycombinator.com"],
        durationMinutes: 120,
      },
      {
        ...EMPTY_MESSAGE,
        content: { text: "Block Twitter and Hacker News for 2 hours." },
      } as Memory,
    );
    expect(draft.success).toBe(true);
    expect(actionData(draft).websites).toEqual([
      "x.com",
      "twitter.com",
      "news.ycombinator.com",
    ]);
    expect(draft.text).toContain("news.ycombinator.com");
  });

  it("release refuses an unknown or already released rule before asking for confirmation", async () => {
    const unknown = await invokeSubaction(harness, "release", {
      ruleId: "x.com",
    });
    expect(unknown.success).toBe(false);
    expect(actionData(unknown).error).toBe("BLOCK_RULE_NOT_FOUND");
    expect(actionData(unknown).requiresConfirmation).toBeUndefined();

    const missing = await invokeSubaction(harness, "release", {
      ruleId: "00000000-0000-4000-8000-00000000dead",
    });
    expect(missing.success).toBe(false);
    expect(actionData(missing).error).toBe("BLOCK_RULE_NOT_FOUND");
    expect(actionData(missing).requiresConfirmation).toBeUndefined();

    const writer = new BlockRuleWriter(harness.runtime);
    const ruleId = await writer.createBlockRule({
      profile: "focus",
      websites: ["x.com"],
      gateType: "until_todo",
      gateTodoId: "todo-released",
    });
    await writer.releaseBlockRule(ruleId, { confirmed: true, reason: "done" });

    const released = await invokeSubaction(harness, "release", { ruleId });
    expect(released.success).toBe(false);
    expect(actionData(released).error).toBe("BLOCK_RULE_ALREADY_RELEASED");
    expect(actionData(released).requiresConfirmation).toBeUndefined();
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

    const pending = await invokeSubaction(harness, "release", {
      ruleId: normalId,
      reason: "done",
    });
    expect(pending.success).toBe(true);
    expect(actionData(pending).requiresConfirmation).toBe(true);

    const harshAttempt = await invokeSubaction(
      harness,
      "release",
      { ruleId: harshId, reason: "done" },
      {
        ...EMPTY_MESSAGE,
        content: { text: "yes" },
      } as Memory,
    );
    expect(harshAttempt.success).toBe(false);
    expect(harshAttempt.text ?? "").toMatch(/harsh_no_bypass/);

    const ok = await invokeSubaction(
      harness,
      "release",
      { ruleId: normalId, reason: "done" },
      {
        ...EMPTY_MESSAGE,
        content: { text: "yes" },
      } as Memory,
    );
    expect(ok.success).toBe(true);
    const reader = new BlockRuleReader(harness.runtime);
    const released = await reader.getBlockRuleById(normalId);
    expect(released?.active).toBe(false);
    expect(released?.releasedReason).toBe("done");
  });
});
