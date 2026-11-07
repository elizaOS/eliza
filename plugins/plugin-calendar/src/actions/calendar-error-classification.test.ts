import { AgentRuntime, EventType, type Memory } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  createErrorReportedEscalationHandler,
  ErrorEscalationTracker,
} from "../../../../packages/agent/src/runtime/error-escalation.ts";
import { EscalationService } from "../../../../packages/agent/src/services/escalation.ts";
import { CalendarServiceError } from "../internal/errors.ts";
import { CalendarService } from "../service/CalendarService.ts";
import { createCalendarActionRunner } from "./calendar-handler.ts";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const runtime = new AgentRuntime({
    character: { name: "Calendar diagnostic boundary", bio: [] },
    logLevel: "fatal",
  });
  const service = new CalendarService(runtime);
  runtime.services.set(CalendarService.serviceType, [service]);
  const escalation = vi
    .spyOn(EscalationService, "startEscalation")
    .mockResolvedValue({
      id: "test",
      reason: "test",
      text: "test",
      currentStep: 0,
      channelsSent: [],
      startedAt: 0,
      lastSentAt: 0,
      resolved: false,
    });
  runtime.registerEvent(
    EventType.ERROR_REPORTED,
    createErrorReportedEscalationHandler(
      runtime,
      new ErrorEscalationTracker(1, 60000),
      1,
    ),
  );
  const unexpectedModel = vi.fn(async () => {
    throw Error("No model call permitted");
  });
  const action = createCalendarActionRunner({
    runTextModel: unexpectedModel,
    runJsonModel: unexpectedModel,
    recentConversationTexts: async () => [],
  });
  const message = {
    id: "00000000-0000-0000-0000-000000000011",
    entityId: "00000000-0000-0000-0000-000000000002",
    roomId: "00000000-0000-0000-0000-000000000003",
    agentId: runtime.agentId,
    createdAt: Date.parse("2026-10-27T20:00:00Z"),
    content: { text: "Am I free tomorrow at 3:05pm?" },
  } as Memory;
  return { runtime, service, escalation, action, message, unexpectedModel };
}
it("keeps actual mixed-window rejection diagnostic without an operator escalation", async () => {
  const f = fixture(),
    read = vi.spyOn(f.service, "getCalendarFeed");
  const result = await f.action.handler(f.runtime, f.message, undefined, {
    parameters: {
      subaction: "feed",
      details: {
        date: "2026-10-28",
        timeMin: "2026-10-28T15:00:00",
        timeMax: "2026-10-28T15:15:00",
        timeZone: "America/Los_Angeles",
      },
    },
  });
  expect(result).toMatchObject({
    success: false,
    data: { error: "CALENDAR_READ_DATE_CONFLICT", coachingFailure: true },
  });
  expect(read).not.toHaveBeenCalled();
  expect(f.unexpectedModel).not.toHaveBeenCalled();
  const report = f.runtime
    .getRecentReportedErrors()
    .find((x) => x.scope === "calendar:action");
  expect(report).toMatchObject({
    code: "CALENDAR_READ_DATE_CONFLICT",
    context: { diagnosticOnly: true, status: 400 },
  });
  await Promise.resolve();
  expect(f.escalation).not.toHaveBeenCalled();
});
it.each([
  { status: 401, code: undefined, expected: "CALENDAR_SERVICE_401" },
  {
    status: 503,
    code: "CALENDAR_SERVICE_UNAVAILABLE",
    expected: "CALENDAR_SERVICE_UNAVAILABLE",
  },
  {
    status: 401,
    code: "CALENDAR_READ_DATE_CONFLICT",
    expected: "CALENDAR_READ_DATE_CONFLICT",
  },
  {
    status: 503,
    code: "CALENDAR_READ_DATE_CONFLICT",
    expected: "CALENDAR_READ_DATE_CONFLICT",
  },
])(
  "retains real connector $status failure and escalation",
  async ({ status, code, expected }) => {
    const f = fixture();
    vi.spyOn(f.service, "getCalendarFeed").mockRejectedValue(
      new CalendarServiceError(status, "Connector failure fixture", code),
    );
    const result = await f.action.handler(f.runtime, f.message, undefined, {
      parameters: {
        subaction: "feed",
        details: { date: "2026-10-28", timeZone: "America/Los_Angeles" },
      },
    });
    expect(result).toMatchObject({ success: false, data: { error: expected } });
    expect(
      f.runtime
        .getRecentReportedErrors()
        .find((x) => x.scope === "calendar:action"),
    ).toMatchObject({
      code: expected,
      context: { diagnosticOnly: false, status },
    });
    await vi.waitFor(() => expect(f.escalation).toHaveBeenCalledTimes(1));
    expect(f.unexpectedModel).not.toHaveBeenCalled();
  },
);
it("keeps unknown failures on the ordinary runtime reporting/escalation boundary", async () => {
  const f = fixture(),
    error = new Error("Unknown failure fixture");
  vi.spyOn(f.service, "getCalendarFeed").mockRejectedValue(error);
  await expect(
    f.action.handler(f.runtime, f.message, undefined, {
      parameters: {
        subaction: "feed",
        details: { date: "2026-10-28", timeZone: "America/Los_Angeles" },
      },
    }),
  ).rejects.toBe(error);
  f.runtime.reportError("calendar:outer-action", error);
  expect(f.runtime.getRecentReportedErrors().at(-1)).toMatchObject({
    code: "UNCLASSIFIED",
  });
  await vi.waitFor(() => expect(f.escalation).toHaveBeenCalledTimes(1));
  expect(f.unexpectedModel).not.toHaveBeenCalled();
});
