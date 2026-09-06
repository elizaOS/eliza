/**
 * Real PA umbrella, Calendar handler, executor, planner loop, and evaluator.
 * Queued model outputs and an in-memory calendar service prove ownership and
 * receipt transport, not the semantic accuracy of a live language model.
 */
import { renderGroundedActionReply } from "@elizaos/agent";
import {
  type ActionResult,
  type Content,
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
  ModelType,
} from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  actionResultToPlannerToolResult,
  runPlannerLoop,
} from "../../../../packages/core/src/runtime/planner-loop.ts";
import type {
  PlannerRuntime,
  PlannerToolCall,
} from "../../../../packages/core/src/runtime/planner-types.ts";
import { NoModelProviderConfiguredError } from "../../../../packages/core/src/runtime.ts";
import { calendarAction } from "./calendar.ts";

vi.mock("@elizaos/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/agent")>()),
  renderGroundedActionReply: vi.fn(),
}));

const AGENT_ID = "00000000-0000-0000-0000-000000000501";
const EVENT: LifeOpsCalendarEvent = {
  id: "calendar-event-row-1",
  externalId: "event-local-1",
  agentId: AGENT_ID,
  provider: "eliza",
  side: "owner",
  grantId: "eliza-calendar",
  connectorAccountId: "eliza-calendar",
  calendarId: "primary",
  title: "Gym session",
  description: "",
  location: "",
  status: "confirmed",
  startAt: "2026-09-08T11:00:00.000Z",
  endAt: "2026-09-08T12:00:00.000Z",
  isAllDay: false,
  timezone: "America/New_York",
  htmlLink: null,
  conferenceLink: null,
  organizer: { self: true },
  attendees: [],
  metadata: { etag: '"eliza-1"', version: 1 },
  syncedAt: "2026-09-05T10:00:00.000Z",
  updatedAt: "2026-09-05T10:00:00.000Z",
};

async function runDeletion(
  event: LifeOpsCalendarEvent | null,
  reply: string | Error,
) {
  const request = "Delete the selected gym session.";
  const message = {
    id: "00000000-0000-0000-0000-000000000504",
    agentId: AGENT_ID,
    // This harness exercises settlement, using an authenticated agent-self
    // caller rather than an unresolved external sender with no owner records.
    entityId: AGENT_ID,
    roomId: "00000000-0000-0000-0000-000000000503",
    createdAt: Date.parse("2026-09-05T10:00:00.000Z"),
    content: { text: request, source: "test" },
  } as Memory;
  const storedEventIds = new Set([
    "untouched-event",
    ...(event ? [event.externalId] : []),
  ]);
  const service = {
    getConditionalCalendarMutationTarget: vi.fn(async () => event),
    deleteCalendarEvent: vi.fn(
      async (_url: URL, request: { eventId: string }) => {
        expect(storedEventIds.delete(request.eventId)).toBe(true);
      },
    ),
  };
  const runtime = {
    agentId: AGENT_ID,
    actions: [calendarAction],
    character: { name: "TestAgent" },
    getMemories: vi.fn(async () => []),
    getSetting: vi.fn(() => undefined),
    getService: (name: string) => (name === "calendar" ? service : null),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const delivered: Content[] = [];
  let actionResult: ActionResult | undefined;
  const executeToolCall = vi.fn(async (call: PlannerToolCall) => {
    actionResult = await executePlannedToolCall(
      runtime,
      {
        message,
        userRoles: ["OWNER"],
        activeContexts: ["calendar"],
        callback: async (content) => {
          delivered.push(content);
          return [];
        },
      },
      call,
      { actions: [calendarAction] },
    );
    return actionResultToPlannerToolResult(actionResult);
  });
  const useModel = vi.fn<PlannerRuntime["useModel"]>().mockResolvedValueOnce({
    text: "",
    toolCalls: [
      {
        id: "calendar-delete",
        name: "CALENDAR",
        arguments: {
          action: "delete_event",
          details: {
            eventId: EVENT.externalId,
            grantId: EVENT.grantId,
            calendarId: EVENT.calendarId,
          },
        },
      },
    ],
  });
  if (reply instanceof Error) {
    useModel.mockRejectedValueOnce(reply);
  } else {
    useModel.mockResolvedValueOnce(
      JSON.stringify({
        decision: "FINISH",
        success: event !== null,
        thought:
          "The authoritative Calendar effect receipt determines what happened.",
        messageToUser: reply,
      }),
    );
  }
  const result = await runPlannerLoop({
    runtime: { useModel },
    context: {
      id: "calendar-request",
      events: [
        {
          id: "user-request",
          type: "message",
          message: { role: "user", content: request },
        },
      ],
    },
    tools: [{ name: "CALENDAR", description: calendarAction.description }],
    executeToolCall,
  });
  return {
    actionResult,
    delivered,
    executeToolCall,
    result,
    service,
    storedEventIds,
    useModel,
  };
}

describe("Calendar receipt-grounded evaluator handoff through PA", () => {
  beforeEach(() => {
    vi.mocked(renderGroundedActionReply).mockReset();
    // Poison the removed action-only renderer: these words must never be
    // synthesized or delivered in lieu of the actual evaluator's receipt view.
    vi.mocked(renderGroundedActionReply).mockResolvedValue({
      kind: "model",
      text: "No problem, I deleted it.",
    });
  });

  it.each([
    "The event is absent from the search results; deletion remains unperformed.",
    "Die Suche blieb ergebnislos; der Löschvorgang wurde ausgelassen.",
    "El evento está ausente; la eliminación quedó sin realizar.",
  ])("leaves a noop explanation to the evaluator: %s", async (reply) => {
    const run = await runDeletion(null, reply);
    expect(run.useModel.mock.calls.map(([type]) => type)).toEqual([
      ModelType.ACTION_PLANNER,
      ModelType.RESPONSE_HANDLER,
    ]);
    expect(run.actionResult, JSON.stringify(run.actionResult)).toMatchObject({
      success: false,
      transcriptVisibility: "internal",
      turnComplete: false,
      effectReceipts: [{ outcome: "noop", operation: "calendar.event.delete" }],
      data: {
        retryable: false,
        replyContext: { scenario: "delete_event_not_found" },
      },
    });
    expect(run.actionResult?.text).toBeUndefined();
    expect(run.actionResult?.userFacingText).toBeUndefined();
    expect(run.actionResult?.verifiedUserFacing).toBeUndefined();
    expect(run.delivered).toEqual([]);
    expect(renderGroundedActionReply).not.toHaveBeenCalled();
    const evaluatorInput = JSON.stringify(
      run.useModel.mock.calls[1]?.[1].messages,
    );
    expect(evaluatorInput).toContain(
      run.actionResult?.effectReceipts?.[0]?.receiptId,
    );
    expect(evaluatorInput).toContain("unique target could not be resolved");
    expect(run.result.finalMessage).toBe(reply);
    expect(run.service.deleteCalendarEvent).not.toHaveBeenCalled();
    expect([...run.storedEventIds]).toEqual(["untouched-event"]);
    expect(run.executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("preserves an applied deletion and its evidence without a second mutation or action reply", async () => {
    const reply = "I deleted the gym session from your calendar.";
    const run = await runDeletion(EVENT, reply);
    expect(run.useModel.mock.calls.map(([type]) => type)).toEqual([
      ModelType.ACTION_PLANNER,
      ModelType.RESPONSE_HANDLER,
    ]);
    expect(run.actionResult).toMatchObject({
      success: true,
      transcriptVisibility: "internal",
      data: {
        deleted: true,
        targetEvent: EVENT,
        replyContext: { scenario: "delete_event_completed" },
      },
      effectReceipts: [
        {
          outcome: "applied",
          operation: "calendar.event.delete",
          resource: { id: EVENT.id },
        },
      ],
    });
    expect(run.actionResult?.userFacingEffectReceiptIds).toBeUndefined();
    expect(run.actionResult?.turnComplete).not.toBe(true);
    expect(run.delivered).toEqual([]);
    expect(renderGroundedActionReply).not.toHaveBeenCalled();
    const evaluatorInput = JSON.stringify(
      run.useModel.mock.calls[1]?.[1].messages,
    );
    expect(evaluatorInput).toContain(
      run.actionResult?.effectReceipts?.[0]?.receiptId,
    );
    expect(evaluatorInput).toContain(EVENT.title);
    expect(run.result.finalMessage).toBe(reply);
    expect(run.service.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect([...run.storedEventIds]).toEqual(["untouched-event"]);
    expect(run.executeToolCall).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "HTTP 429",
      kind: "rate_limited",
      error: () => Object.assign(new Error("Rate limit"), { statusCode: 429 }),
    },
    {
      label: "HTTP 503",
      kind: "provider_issue",
      error: () => Object.assign(new Error("Unavailable"), { statusCode: 503 }),
    },
    {
      label: "no provider",
      kind: "no_provider",
      error: () => new NoModelProviderConfiguredError(),
    },
  ])(
    "keeps an applied deletion non-replayable when the evaluator encounters $label",
    async ({ kind, error }) => {
      const run = await runDeletion(EVENT, error());
      expect(run.result.terminalFailure).toMatchObject({
        kind,
        code: "EVALUATOR_REPLY_GENERATION_FAILED",
        transient: false,
      });
      expect(run.result.finalMessage).toBeUndefined();
      expect(run.result.trajectory.steps[0]?.result).toMatchObject({
        success: true,
        effectReceipts: run.actionResult?.effectReceipts,
        data: { deleted: true, targetEvent: EVENT },
      });
      expect(run.useModel.mock.calls.map(([type]) => type)).toEqual([
        ModelType.ACTION_PLANNER,
        ModelType.RESPONSE_HANDLER,
      ]);
      expect(run.delivered).toEqual([]);
      expect(renderGroundedActionReply).not.toHaveBeenCalled();
      expect(run.service.deleteCalendarEvent).toHaveBeenCalledTimes(1);
      expect([...run.storedEventIds]).toEqual(["untouched-event"]);
      expect(run.executeToolCall).toHaveBeenCalledTimes(1);
    },
  );
});
