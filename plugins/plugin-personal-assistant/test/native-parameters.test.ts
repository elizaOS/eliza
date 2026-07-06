/**
 * Covers the native options.parameters migration: resolveActionArgs trusts complete planner
 * parameters without extractor calls, RESOLVE_REQUEST and CALENDAR consume planner fields
 * directly, and CALENDAR is a flat action-valued umbrella. Deterministic, mocked extractor.
 */
import {
  type HandlerOptions,
  type IAgentRuntime,
  listSubactionsFromParameters,
  type Memory,
  promoteSubactionsToActions,
  resolveActionArgs,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarAction } from "../src/actions/calendar.js";
import { resolveRequestAction } from "../src/actions/resolve-request.js";
import {
  createOwnerFactStore,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "../src/lifeops/owner/fact-store.js";

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
  const cache = new Map<string, unknown>();
  return {
    agentId: "agent-native-params",
    useModel: vi.fn(() => {
      throw new Error("legacy extractor should not be called");
    }),
    getService: vi.fn(() => {
      throw new Error("calendar writer should not be called");
    }),
    async getCache<T>(key: string): Promise<T | null> {
      const value = cache.get(key);
      return value === undefined ? null : (value as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
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

  it("promoted RESOLVE_REQUEST_REJECT resolves the only pending approval without model extraction", async () => {
    const runtime = makeRuntime();
    const rejectVirtual = promoteSubactionsToActions(resolveRequestAction).find(
      (action) => action.name === "RESOLVE_REQUEST_REJECT",
    );
    if (!rejectVirtual) {
      throw new Error("RESOLVE_REQUEST_REJECT virtual was not promoted");
    }
    mocks.queue.list.mockResolvedValue([
      { id: "req-1", action: "send_message", channel: "sms", reason: "one" },
    ]);
    mocks.queue.reject.mockResolvedValue({
      id: "req-1",
      action: "send_message",
      state: "rejected",
    });

    const result = await rejectVirtual.handler(
      runtime,
      makeMessage(
        "Wait - which Chris? There are two. Don't send it, reject that for now.",
      ),
      {},
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      data: { requestId: "req-1", state: "rejected" },
    });
    expect(mocks.queue.reject).toHaveBeenCalledWith("req-1", {
      resolvedBy: "owner-1",
      resolutionReason:
        "Wait - which Chris? There are two. Don't send it, reject that for now.",
    });
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("CALENDAR exposes concrete contexts and is a flat action-valued umbrella (no nested subActions/subPlanner)", () => {
    expect(calendarAction.contexts).toEqual([
      "general",
      "calendar",
      "contacts",
      "tasks",
      "connectors",
      "web",
    ]);
    // The legacy 2-layer `subActions` + `subPlanner` dispatch was removed in
    // favor of a flat action enum + `promoteSubactionsToActions` virtuals
    // (CALENDAR_FEED, CALENDAR_CREATE_EVENT, CALENDAR_PROPOSE_TIMES, etc.).
    expect(calendarAction.subActions).toBeUndefined();
    expect(calendarAction.subPlanner).toBeUndefined();
    expect(
      (calendarAction.parameters ?? []).find((p) => p.name === "subaction"),
    ).toBeUndefined();
    const actionParam = (calendarAction.parameters ?? []).find(
      (p) => p.name === "action",
    );
    expect(actionParam).toBeDefined();
    const enumVerbs = listSubactionsFromParameters(calendarAction.parameters);
    expect(enumVerbs).toContain("feed");
    expect(enumVerbs).toContain("create_event");
    expect(enumVerbs).toContain("propose_times");
    expect(enumVerbs).toContain("check_availability");
    expect(enumVerbs).toContain("update_preferences");
  });

  it("CALENDAR create_event fails closed inside stored protected sleep without explicit override", async () => {
    const runtime = makeRuntime();
    registerOwnerFactStore(runtime, createOwnerFactStore(runtime));
    await resolveOwnerFactStore(runtime).update(
      {
        timezone: "UTC",
        quietHours: {
          startLocal: "05:00",
          endLocal: "13:00",
          timezone: "UTC",
        },
      },
      { source: "profile_save", recordedAt: "2026-07-06T00:00:00.000Z" },
    );
    const callbackTexts: string[] = [];

    const result = await calendarAction.handler(
      runtime,
      makeMessage(
        "Can you throw a team sync on my calendar for 10am tomorrow?",
      ),
      {},
      {
        parameters: {
          action: "create_event",
          title: "team sync",
          details: {
            start: "2026-07-07T10:00:00.000Z",
            end: "2026-07-07T10:30:00.000Z",
          },
        },
      },
      async (content) => {
        if (typeof content.text === "string") {
          callbackTexts.push(content.text);
        }
        return [];
      },
    );

    expect(result).toMatchObject({
      success: false,
      data: {
        error: "PROTECTED_SLEEP_CONFLICT",
        noop: true,
        requestedLocalTime: "10:00",
      },
    });
    expect(String(result.text)).toContain("protected quiet/sleep window");
    expect(String(result.text)).toContain("explicit override");
    expect(callbackTexts.join("\n")).toContain("after 14:00");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(runtime.getService).not.toHaveBeenCalled();
  });
});
