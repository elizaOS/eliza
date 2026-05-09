import { afterEach, describe, expect, it, vi } from "vitest";
import { getCalendlyAvailability } from "./calendly-client.js";

const ORIGINAL_MOCK_BASE = process.env.ELIZA_MOCK_CALENDLY_BASE;

describe("Calendly API client", () => {
  afterEach(() => {
    if (ORIGINAL_MOCK_BASE === undefined) {
      delete process.env.ELIZA_MOCK_CALENDLY_BASE;
    } else {
      process.env.ELIZA_MOCK_CALENDLY_BASE = ORIGINAL_MOCK_BASE;
    }
    vi.unstubAllGlobals();
  });

  it("rewrites absolute api.calendly.com URLs to the mock base", async () => {
    process.env.ELIZA_MOCK_CALENDLY_BASE = "http://127.0.0.1:3003";
    const urls: string[] = [];

    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("http://127.0.0.1:3003/event_type_available_times")) {
        return new Response(
          JSON.stringify({
            collection: [
              {
                start_time: "2026-04-21T15:00:00Z",
                status: "available",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "http://127.0.0.1:3003/event_types/abc") {
        return new Response(
          JSON.stringify({
            resource: {
              uri: "https://api.calendly.com/event_types/abc",
              name: "30 Minute Meeting",
              slug: "30min",
              scheduling_url: "https://calendly.com/test/30min",
              duration: 30,
              active: true,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ message: "unexpected URL" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });

    const availability = await getCalendlyAvailability(
      { personalAccessToken: "fake-token" },
      "https://api.calendly.com/event_types/abc",
      {
        startDate: "2026-04-20",
        endDate: "2026-04-24",
      },
    );

    expect(urls).toContain("http://127.0.0.1:3003/event_types/abc");
    expect(
      urls.some((url) => url.startsWith("https://api.calendly.com")),
    ).toBe(false);
    expect(availability).toEqual([
      {
        date: "2026-04-21",
        slots: [
          {
            startTime: "2026-04-21T15:00:00Z",
            endTime: "2026-04-21T15:30:00.000Z",
          },
        ],
      },
    ]);
  });
});
