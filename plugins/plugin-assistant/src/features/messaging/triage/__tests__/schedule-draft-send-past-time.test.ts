/**
 * A scheduled draft send fires when its time is reached, and a time that is
 * already past is reached on the next scheduler tick. A misread sendAt
 * (epoch seconds, a bare year, a blank) must be refused instead of handed to
 * the scheduler, or "send later" sends at once while the action reports
 * "Scheduled". Real scheduleDraftSendAction handler; the triage service's
 * draft lookup and scheduler call are stubbed.
 */
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { scheduleDraftSendAction } from "../actions/scheduleDraftSend.ts";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
} from "../triage-service.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

afterEach(() => {
  vi.restoreAllMocks();
  __resetDefaultTriageServiceForTests();
});

function stubService() {
  const service = getDefaultTriageService();
  vi.spyOn(service, "getDraft").mockReturnValue({ draftId: "d1" } as never);
  return vi.spyOn(service, "scheduleDraftSend").mockResolvedValue({
    draftId: "d1",
    scheduleCommit: {
      kind: "scheduled_task",
      id: "t1",
      idempotencyKey: "k1",
      replayed: false,
      committedAt: new Date().toISOString(),
    },
  } as never);
}

async function schedule(runtime: IAgentRuntime, sendAt: unknown) {
  return scheduleDraftSendAction.handler(runtime, {} as Memory, undefined, {
    parameters: { draftId: "d1", sendAt },
  } as unknown as HandlerOptions);
}

it.each([
  ["epoch seconds", "1760716800"],
  ["a bare year", "2026"],
  ["a blank", " "],
  ["a past ISO time", "2020-01-01T09:00:00Z"],
])("refuses %s instead of sending the draft at once", async (_case, sendAt) => {
  const scheduled = stubService();
  const result = await schedule(createFakeRuntime(), sendAt);
  expect(result?.success).toBe(false);
  expect(result?.text).toMatch(/must be in the future/);
  expect(scheduled).not.toHaveBeenCalled();
});

it("schedules a future time", async () => {
  const scheduled = stubService();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const result = await schedule(createFakeRuntime(), future);
  expect(result?.success).toBe(true);
  expect(scheduled).toHaveBeenCalledWith(
    expect.anything(),
    "d1",
    Date.parse(future),
  );
});

it("reads an offset-free sendAt in the message's time zone, not the host's", async () => {
  const scheduled = stubService();
  // "Send it Monday at 9am" arrives as a wall clock in the user's zone;
  // New York is on EST (-05:00) in November.
  const message = {
    content: {
      text: "send it monday 9am",
      metadata: { uiTimeZone: "America/New_York" },
    },
  } as unknown as Memory;
  const result = await scheduleDraftSendAction.handler(
    createFakeRuntime(),
    message,
    undefined,
    {
      parameters: { draftId: "d1", sendAt: "2030-11-04T09:00:00" },
    } as unknown as HandlerOptions,
  );
  expect(result?.success).toBe(true);
  expect(scheduled).toHaveBeenCalledWith(
    expect.anything(),
    "d1",
    Date.parse("2030-11-04T14:00:00Z"),
  );
});
