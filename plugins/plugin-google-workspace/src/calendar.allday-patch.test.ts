/**
 * Regression coverage for all-day event rescheduling. Exercises the real
 * GoogleCalendarClient.updateEvent over a mock client factory whose events.get
 * returns an all-day (date-only) event and whose events.patch echoes the
 * request body. When only one bound of an all-day event is patched, the derived
 * counterpart must stay a date-only {date} value so the patch body does not mix
 * an all-day date with a timed dateTime — the exact shape Google Calendar's
 * events.patch rejects with HTTP 400 ("Cannot combine date and dateTime").
 */
import type { calendar_v3 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient } from "./calendar";
import type { GoogleApiClientFactory } from "./client-factory";

type PatchMock = ReturnType<typeof vi.fn>;

function updateEventCapture(existing: calendar_v3.Schema$Event): {
  client: GoogleCalendarClient;
  patch: PatchMock;
} {
  const patch = vi.fn(async (params: calendar_v3.Params$Resource$Events$Patch) => ({
    data: { id: params.eventId, ...params.requestBody },
  }));
  const events = {
    get: vi.fn(async () => ({ data: existing })),
    patch,
  };
  const factory = {
    calendar: vi.fn(async () => ({ events })),
  } as unknown as GoogleApiClientFactory;
  return { client: new GoogleCalendarClient(factory), patch };
}

function patchedBody(patch: PatchMock): calendar_v3.Schema$Event {
  const call = patch.mock.calls[0]?.[0] as calendar_v3.Params$Resource$Events$Patch;
  return call.requestBody as calendar_v3.Schema$Event;
}

describe("GoogleCalendarClient all-day reschedule patch", () => {
  it("keeps the derived end date-only when only the start of an all-day event is patched", async () => {
    const { client, patch } = updateEventCapture({
      id: "allday-1",
      start: { date: "2026-06-01" },
      end: { date: "2026-06-03" },
    });

    await client.updateEvent({ accountId: "acct-1", eventId: "allday-1", start: "2026-06-05" });

    const body = patchedBody(patch);
    // Existing span is 2 whole days (Jun 1 -> Jun 3), preserved from the new start.
    expect(body.start?.date).toBe("2026-06-05");
    expect(body.end?.date).toBe("2026-06-07");
    expect(body.start?.dateTime).toBeUndefined();
    expect(body.end?.dateTime).toBeUndefined();
  });

  it("keeps the derived start date-only when only the end of an all-day event is patched", async () => {
    const { client, patch } = updateEventCapture({
      id: "allday-2",
      start: { date: "2026-06-01" },
      end: { date: "2026-06-03" },
    });

    await client.updateEvent({ accountId: "acct-1", eventId: "allday-2", end: "2026-06-10" });

    const body = patchedBody(patch);
    expect(body.end?.date).toBe("2026-06-10");
    expect(body.start?.date).toBe("2026-06-08");
    expect(body.start?.dateTime).toBeUndefined();
    expect(body.end?.dateTime).toBeUndefined();
  });

  it("defaults to a one-day span when the existing all-day duration is unknown", async () => {
    const { client, patch } = updateEventCapture({
      id: "allday-3",
      start: { date: "2026-06-01" },
      // No end bound -> span cannot be inferred and must default to one day.
    });

    await client.updateEvent({ accountId: "acct-1", eventId: "allday-3", start: "2026-06-05" });

    const body = patchedBody(patch);
    expect(body.start?.date).toBe("2026-06-05");
    expect(body.end?.date).toBe("2026-06-06");
    expect(body.end?.dateTime).toBeUndefined();
  });

  it("still derives a timed dateTime end for timed events (unchanged behavior)", async () => {
    const { client, patch } = updateEventCapture({
      id: "timed-1",
      start: { dateTime: "2026-06-01T09:00:00.000Z" },
      end: { dateTime: "2026-06-01T10:00:00.000Z" },
    });

    await client.updateEvent({
      accountId: "acct-1",
      eventId: "timed-1",
      start: "2026-06-05T09:00:00.000Z",
    });

    const body = patchedBody(patch);
    expect(body.start?.dateTime).toBe("2026-06-05T09:00:00.000Z");
    expect(body.end?.dateTime).toBe("2026-06-05T10:00:00.000Z");
    expect(body.start?.date).toBeUndefined();
    expect(body.end?.date).toBeUndefined();
  });
});
