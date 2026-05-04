import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  type CalendarEventLookupLike,
  GOOGLE_DISTANCE_MATRIX_URL,
  type LocationProviderLike,
  type TravelTimeFetch,
  TravelTimeService,
  type TravelTimeUnavailableError,
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

  it("fails explicitly when GOOGLE_MAPS_API_KEY is absent", async () => {
    const service = new TravelTimeService(runtime, {
      calendar: makeCalendar([makeEvent({})]),
      getApiKey: () => undefined,
    });
    await expect(
      service.computeBuffer({
        eventId: "evt-1",
        originAddress: "100 Main St",
      }),
    ).rejects.toMatchObject({
      name: "TravelTimeUnavailableError",
      code: "MISSING_API_KEY",
    } satisfies Partial<TravelTimeUnavailableError>);
  });

  it("fails explicitly when the Distance Matrix HTTP call errors", async () => {
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
    await expect(
      service.computeBuffer({
        eventId: "evt-1",
        originAddress: "100 Main St",
      }),
    ).rejects.toMatchObject({
      name: "TravelTimeUnavailableError",
      code: "DISTANCE_MATRIX_FAILED",
    } satisfies Partial<TravelTimeUnavailableError>);
  });

  it("fails explicitly when Distance Matrix reports non-OK element status", async () => {
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
    await expect(
      service.computeBuffer({
        eventId: "evt-1",
        originAddress: "100 Main St",
      }),
    ).rejects.toMatchObject({
      name: "TravelTimeUnavailableError",
      code: "INVALID_DISTANCE_MATRIX_RESPONSE",
    } satisfies Partial<TravelTimeUnavailableError>);
  });

  it("throws when the event cannot be found", async () => {
    const service = new TravelTimeService(runtime, {
      calendar: makeCalendar([]),
      getApiKey: () => "test-key",
    });
    await expect(service.computeBuffer({ eventId: "missing" })).rejects.toThrow(
      /not found/,
    );
  });

  describe("location-plugin fallback when origin is omitted", () => {
    function captureFetchUrl(): {
      capturedUrl: { value: string | null };
      fetchImpl: TravelTimeFetch;
    } {
      const capturedUrl = { value: null as string | null };
      const fetchImpl: TravelTimeFetch = async (url) => {
        capturedUrl.value = url;
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
                    duration: { value: 720, text: "12 mins" },
                  },
                ],
              },
            ],
          }),
        };
      };
      return { capturedUrl, fetchImpl };
    }

    it("uses the Location plugin coords when permission is granted", async () => {
      const { capturedUrl, fetchImpl } = captureFetchUrl();
      const locationProvider: LocationProviderLike = {
        async checkPermissions() {
          return { location: "granted" };
        },
        async getCurrentPosition() {
          return {
            coords: { latitude: 37.7749, longitude: -122.4194 },
          };
        },
      };
      const service = new TravelTimeService(runtime, {
        calendar: makeCalendar([makeEvent({})]),
        fetchImpl,
        getApiKey: () => "test-key",
        locationProvider,
      });
      const result = await service.computeBuffer({ eventId: "evt-1" });
      expect(result.method).toBe("maps-api");
      expect(result.bufferMinutes).toBe(12);
      expect(result.originAddress).toBe("37.7749,-122.4194");
      expect(capturedUrl.value).toContain(
        encodeURIComponent("37.7749,-122.4194"),
      );
    });

    it("throws MISSING_ORIGIN when the user has denied location permission", async () => {
      const locationProvider: LocationProviderLike = {
        async checkPermissions() {
          return { location: "denied" };
        },
        async getCurrentPosition() {
          throw new Error("should not be called when permission is denied");
        },
      };
      const service = new TravelTimeService(runtime, {
        calendar: makeCalendar([makeEvent({})]),
        getApiKey: () => "test-key",
        locationProvider,
      });
      await expect(
        service.computeBuffer({ eventId: "evt-1" }),
      ).rejects.toMatchObject({
        name: "TravelTimeUnavailableError",
        code: "MISSING_ORIGIN",
      } satisfies Partial<TravelTimeUnavailableError>);
    });

    it("throws MISSING_ORIGIN when the plugin returns no fix", async () => {
      const locationProvider: LocationProviderLike = {
        async checkPermissions() {
          return { location: "granted" };
        },
        async getCurrentPosition() {
          return null;
        },
      };
      const service = new TravelTimeService(runtime, {
        calendar: makeCalendar([makeEvent({})]),
        getApiKey: () => "test-key",
        locationProvider,
      });
      await expect(
        service.computeBuffer({ eventId: "evt-1" }),
      ).rejects.toMatchObject({
        name: "TravelTimeUnavailableError",
        code: "MISSING_ORIGIN",
      } satisfies Partial<TravelTimeUnavailableError>);
    });

    it("throws MISSING_ORIGIN with provider context when getCurrentPosition rejects", async () => {
      const locationProvider: LocationProviderLike = {
        async checkPermissions() {
          return { location: "granted" };
        },
        async getCurrentPosition() {
          throw new Error("native bridge timeout");
        },
      };
      const service = new TravelTimeService(runtime, {
        calendar: makeCalendar([makeEvent({})]),
        getApiKey: () => "test-key",
        locationProvider,
      });
      await expect(
        service.computeBuffer({ eventId: "evt-1" }),
      ).rejects.toMatchObject({
        name: "TravelTimeUnavailableError",
        code: "MISSING_ORIGIN",
        message: expect.stringContaining(
          "location plugin failed during getCurrentPosition",
        ),
      });
    });

    it("prefers an explicit originAddress over the plugin", async () => {
      let pluginCalls = 0;
      const { fetchImpl } = captureFetchUrl();
      const locationProvider: LocationProviderLike = {
        async checkPermissions() {
          pluginCalls += 1;
          return { location: "granted" };
        },
        async getCurrentPosition() {
          pluginCalls += 1;
          return {
            coords: { latitude: 0, longitude: 0 },
          };
        },
      };
      const service = new TravelTimeService(runtime, {
        calendar: makeCalendar([makeEvent({})]),
        fetchImpl,
        getApiKey: () => "test-key",
        locationProvider,
      });
      const result = await service.computeBuffer({
        eventId: "evt-1",
        originAddress: "100 Main St, San Francisco",
      });
      expect(result.originAddress).toBe("100 Main St, San Francisco");
      expect(pluginCalls).toBe(0);
    });
  });
});
