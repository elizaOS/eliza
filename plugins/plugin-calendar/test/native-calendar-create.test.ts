/**
 * Native phone Calendar create (the requesting-device path a phone uses before
 * the owner's on-device review). A normal solo request prepares one guestless
 * event; extraction evidence that does not match the original request, such as
 * an invented guest address, is refused with a plain "No event was created"
 * answer instead of escaping the action as an exception the planner repeats.
 * Synthetic model output only; nothing is saved.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  inferNativeCalendarCreate,
  registerCalendarActionHostAdapter,
} from "../src/actions/calendar-handler.ts";

type HostAdapter = Parameters<typeof registerCalendarActionHostAdapter>[1];

const REQUEST = "Add lunch with Sam tomorrow at noon";
const message = (text = REQUEST): Memory =>
  ({
    id: "00000000-0000-4000-8000-000000000450",
    entityId: "00000000-0000-4000-8000-000000000102",
    roomId: "00000000-0000-4000-8000-000000000103",
    createdAt: Date.parse("2026-09-18T12:00:00.000Z"),
    content: { text },
  }) as Memory;

function plan(guestIntent: Record<string, unknown>) {
  const evidence = [
    {
      sourceId: "current:00000000-0000-4000-8000-000000000450",
      quote: REQUEST,
    },
  ];
  return {
    title: "Lunch with Sam",
    grantId: null,
    calendarId: null,
    requiresInput: false,
    clarification: null,
    startAt: "2026-09-19T12:00:00",
    endAt: "2026-09-19T13:00:00",
    timeZone: null,
    description: null,
    location: null,
    recurrence: null,
    travelOriginAddress: null,
    durationMinutes: 60,
    isShortPreparation: false,
    guestIntent: { state: "none", evidence, guests: [], ...guestIntent },
    noteIntent: { state: "none", evidence, sourceNote: null },
  };
}

function runtimeWith(parsed: Record<string, unknown>) {
  const reportError = vi.fn();
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    getService: () => null,
    reportError,
  } as unknown as IAgentRuntime;
  const runJsonModel = vi.fn(async () => ({
    rawResponse: JSON.stringify(parsed),
    parsed,
  }));
  registerCalendarActionHostAdapter(runtime, {
    runJsonModel: runJsonModel as unknown as HostAdapter["runJsonModel"],
    recentConversationTexts: async () => [],
  });
  return { runtime, reportError, runJsonModel };
}

const infer = (runtime: IAgentRuntime) =>
  inferNativeCalendarCreate({
    runtime,
    message: message(),
    timeZone: "America/New_York",
    signal: new AbortController().signal,
  });

describe("native phone Calendar create", () => {
  it("prepares a solo request as one guestless event for the owner's review", async () => {
    const { runtime, runJsonModel } = runtimeWith(plan({}));
    const draft = await infer(runtime);
    expect(draft.fields).toMatchObject({
      title: "Lunch with Sam",
      start: "2026-09-19T16:00:00.000Z",
      end: "2026-09-19T17:00:00.000Z",
      timeZone: "America/New_York",
    });
    expect(draft.text).toContain("No event has been created yet");
    expect(runJsonModel).toHaveBeenCalledTimes(1);
  });

  it("refuses an invented guest address with a plain answer and no exception", async () => {
    const { runtime, reportError, runJsonModel } = runtimeWith(
      plan({
        state: "requested",
        guests: [
          { name: "Sam", email: "sam.taylor@acme.com", optional: false },
        ],
      }),
    );
    const draft = await infer(runtime);
    expect(draft.fields).toBeUndefined();
    expect(draft.text).toBe(
      "The event details could not be confirmed from your request. No event was created. Say the title, date and time again.",
    );
    expect(reportError).toHaveBeenCalledWith(
      "calendar:native-create",
      expect.objectContaining({ code: "CALENDAR_CREATE_EVIDENCE_INVALID" }),
      { diagnosticOnly: true, code: "CALENDAR_CREATE_EVIDENCE_INVALID" },
    );
    // One extraction; nothing is retried with the rejected arguments.
    expect(runJsonModel).toHaveBeenCalledTimes(1);
  });

  it("refuses evidence that does not cite the whole request for a solo event", async () => {
    const { runtime } = runtimeWith(
      plan({
        evidence: [
          {
            sourceId: "current:00000000-0000-4000-8000-000000000450",
            quote: "lunch with Sam",
          },
        ],
      }),
    );
    const draft = await infer(runtime);
    expect(draft.fields).toBeUndefined();
    expect(draft.text).toContain("No event was created.");
  });

  it("asks for a named guest's address instead of preparing a guestless event", async () => {
    const { runtime } = runtimeWith(
      plan({
        state: "requested",
        guests: [{ name: "Sam", email: null, optional: false }],
      }),
    );
    const draft = await infer(runtime);
    expect(draft.fields).toBeUndefined();
    expect(draft.text).toContain("guest's valid email address");
  });
});
