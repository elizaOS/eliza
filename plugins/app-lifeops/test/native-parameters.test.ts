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

vi.mock("@elizaos/agent/security/access", () => ({
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
  } as unknown as IAgentRuntime;
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

  it("CALENDAR exposes concrete context and child action metadata", () => {
    expect(calendarAction.contexts).toEqual([
      "calendar",
      "contacts",
      "tasks",
    ]);
    expect(
      calendarAction.subActions?.map((action) =>
        typeof action === "string" ? action : action.name,
      ),
    ).toEqual([
      "CALENDAR_ACTION",
      "PROPOSE_MEETING_TIMES",
      "CHECK_AVAILABILITY",
      "UPDATE_MEETING_PREFERENCES",
      "CALENDLY",
      "SCHEDULING",
    ]);
  });
});
