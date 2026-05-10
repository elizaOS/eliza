import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarAction } from "../src/actions/calendar.js";
import { resolveRequestAction } from "../src/actions/resolve-request.js";
import { resolveActionArgs } from "../src/actions/lib/resolve-action-args.js";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(),
  queue: {
    list: vi.fn(),
    reject: vi.fn(),
    approve: vi.fn(),
  },
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: vi.fn(() => mocks.queue),
}));

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-native-params",
    useModel: vi.fn(() => {
      throw new Error("legacy extractor should not be called");
    }),
  } as IAgentRuntime;
}

function makeMessage(text = "reject req-1"): Memory {
  return {
    entityId: "owner-1",
    content: { text },
  } as Memory;
}

describe("LifeOps native options.parameters migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasOwnerAccess.mockResolvedValue(true);
  });

  it("resolveActionArgs trusts complete planner parameters without extractor calls", async () => {
    const runtime = makeRuntime();
    const result = await resolveActionArgs<"snooze", Record<string, unknown>>({
      runtime,
      message: makeMessage("snooze brushing"),
      actionName: "LIFE",
      subactions: {
        snooze: {
          description: "Snooze an occurrence.",
          descriptionCompressed: "snooze occurrence",
          required: ["target"],
          optional: ["minutes"],
        },
      },
      options: {
        parameters: {
          subaction: "snooze",
          target: "Brush teeth",
          minutes: 30,
        },
      } as HandlerOptions,
    });

    expect(result).toMatchObject({
      ok: true,
      subaction: "snooze",
      params: {
        subaction: "snooze",
        target: "Brush teeth",
        minutes: 30,
      },
    });
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("RESOLVE_REQUEST uses planner requestId/reason without resolution extraction", async () => {
    const runtime = makeRuntime();
    mocks.queue.list.mockResolvedValue([
      { id: "req-1", action: "send_message", channel: "sms", reason: "one" },
      { id: "req-2", action: "send_email", channel: "gmail", reason: "two" },
    ]);
    mocks.queue.reject.mockResolvedValue({
      id: "req-1",
      action: "send_message",
      state: "rejected",
    });

    const result = await resolveRequestAction.handler(
      runtime,
      makeMessage("no, not that one"),
      {},
      {
        parameters: {
          subaction: "reject",
          requestId: "req-1",
          reason: "not now",
        },
      },
    );

    expect(result).toMatchObject({
      success: true,
      data: { requestId: "req-1", state: "rejected" },
    });
    expect(mocks.queue.reject).toHaveBeenCalledWith("req-1", {
      resolvedBy: "owner-1",
      resolutionReason: "not now",
    });
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("CALENDAR exposes concrete contexts and is a flat-subaction umbrella (no nested subActions/subPlanner)", () => {
    expect(calendarAction.contexts).toEqual([
      "general",
      "calendar",
      "contacts",
      "tasks",
      "connectors",
      "web",
    ]);
    // The legacy 2-layer `subActions` + `subPlanner` dispatch was removed in
    // favor of a flat subaction enum + `promoteSubactionsToActions` virtuals
    // (CALENDAR_FEED, CALENDAR_CREATE_EVENT, CALENDAR_PROPOSE_TIMES, etc.).
    expect(calendarAction.subActions).toBeUndefined();
    expect(calendarAction.subPlanner).toBeUndefined();
    const subactionParam = (calendarAction.parameters ?? []).find(
      (p) => p.name === "subaction",
    );
    expect(subactionParam).toBeDefined();
    const enumVerbs = (subactionParam?.schema as { enum?: readonly string[] })
      .enum;
    expect(enumVerbs).toContain("feed");
    expect(enumVerbs).toContain("create_event");
    expect(enumVerbs).toContain("propose_times");
    expect(enumVerbs).toContain("check_availability");
    expect(enumVerbs).toContain("update_preferences");
  });
});
