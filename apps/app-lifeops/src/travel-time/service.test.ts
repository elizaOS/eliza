import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared/contracts/lifeops";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_FIXED_BUFFER_MINUTES,
  GOOGLE_DISTANCE_MATRIX_URL,
  TravelTimeService,
  type CalendarEventLookupLike,
  type TravelTimeFetch,
} from "./service.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000099";

function makeEvent(
  overrides: Partial<LifeOpsCalendarEvent>,
): LifeOpsCalendarEvent {
  const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  return {
    id: "evt-1",
    externalId: "google-evt-1",
    agentId: AGENT_ID,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Lunch at Tartine",
    description: "",
    location: "Tartine Bakery, San Francisco",
    status: "confirmed",
    startAt: start,
    endAt: end,
    isAllDay: false,
    timezone: "UTC",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCalendar(events: LifeOpsCalendarEvent[]): CalendarEventLookupLike {
  return {
    async getCalendarFeed(): Promise<LifeOpsCalendarFeed> {
      return {
        calendarId: "primary",
        events,
        source: "cache",
        timeMin: new Date(Date.now() - 86_400_000).toISOString(),
        timeMax: new Date(Date.now() + 86_400_000).toISOString(),
        syncedAt: null,
      };
    },
  };
}

const runtime = { agentId: AGENT_ID } as unknown as IAgentRuntime;

describe("TravelTimeService", () => {
  it("returns maps-api buffer using duration_in_traffic when Distance Matrix succeeds", async () => {
    let capturedUrl: string | null = null;
    const fetchImpl: TravelTimeFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "OK",
          rows: [
            {
              elements: [
                {
                  status: "OK",
                  duration: { value: 900, text: "15 mins" },
                  duration_in_traffic: { value: 1500, text: "25 mins" },
                },
              ],
            },
          ],
        }),
      };
    };
    const service = new TravelTimeService(runtime, {
      calendar: makeCalendar([makeEvent({})]),
      fetchImpl,
      getApiKey: () => "test-key",
    });
    const result = await service.computeBuffer({
      eventId: "evt-1",
      originAddress: "100 Main St, San Francisco",
    });
    expect(result.method).toBe("maps-api");
    expect(result.bufferMinutes).toBe(25);
    expect(result.originAddress).toBe("100 Main St, San Francisco");
    expect(result.destinationAddress).toBe("Tartine Bakery, San Francisco");
    expect(capturedUrl).toContain(GOOGLE_DISTANCE_MATRIX_URL);
    expect(capturedUrl).toContain("departure_time=now");
    expect(capturedUrl).toContain("key=test-key");
  });

  it("computes a buffer directly from a created event object", async () => {
    const fetchImpl: TravelTimeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "OK",
        rows: [
          {
            elements: [
              {
                status: "OK",
                duration: { value: 600, text: "10 mins" },
              },
            ],
          },
        ],
      }),
    });
    const service = new TravelTimeService(runtime, {
      calendar: makeCalendar([makeEvent({})]),
      fetchImpl,
      getApiKey: () => "test-key",
    });
    const result = await service.computeBufferForEvent(
      { location: "Tartine Bakery, San Francisco" },
      "100 Main St, San Francisco",
    );
    expect(result.method).toBe("maps-api");
    expect(result.bufferMinutes).toBe(10);
    expect(result.originAddress).toBe("100 Main St, San Francisco");
    expect(result.destinationAddress).toBe("Tartine Bakery, San Francisco");
  });

  it("returns fallback-fixed when GOOGLE_MAPS_API_KEY is absent", async () => {
    const service = new TravelTimeService(runtime, {
      calendar: makeCalendar([makeEvent({})]),
      getApiKey: () => undefined,
    });
    const result = await service.computeBuffer({
      eventId: "evt-1",
      originAddress: "100 Main St",
    });
    expect(result.method).toBe("fallback-fixed");
    expect(result.bufferMinutes).toBe(FALLBACK_FIXED_BUFFER_MINUTES);
    expect(result.reason).toContain("GOOGLE_MAPS_API_KEY");
  });

  it("returns fallback-fixed when the Distance Matrix HTTP call errors", async () => {
    const fetchImpl: TravelTimeFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const service = new TravelTimeService(runtime, {
      calendar: makeCalendar([makeEvent({})]),
      fetchImpl,
      getApiKey: () => "test-key",
    });
    const result = await service.computeBuffer({
      eventId: "evt-1",
      originAddress: "100 Main St",
    });
    expect(result.method).toBe("fallback-fixed");
    expect(result.bufferMinutes).toBe(FALLBACK_FIXED_BUFFER_MINUTES);
    expect(result.reason).toContain("status 500");
  });

  it("returns fallback-fixed when Distance Matrix reports non-OK element status", async () => {
    const fetchImpl: TravelTimeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "OK",
        rows: [{ elements: [{ status: "ZERO_RESULTS" }] }],
      }),
    });
    const service = new TravelTimeService(runtime, {
      calendar: makeCalendar([makeEvent({})]),
      fetchImpl,
      getApiKey: () => "test-key",
    });
    const result = await service.computeBuffer({
      eventId: "evt-1",
      originAddress: "100 Main St",
    });
    expect(result.method).toBe("fallback-fixed");
    expect(result.reason).toContain("ZERO_RESULTS");
  });

  it("throws when the event cannot be found", async () => {
    const service = new TravelTimeService(runtime, {
      calendar: makeCalendar([]),
      getApiKey: () => "test-key",
    });
    await expect(
      service.computeBuffer({ eventId: "missing" }),
    ).rejects.toThrow(/not found/);
  });
});
