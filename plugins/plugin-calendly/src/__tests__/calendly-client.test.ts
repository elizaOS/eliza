/**
 * Unit tests for CalendlyClient — auth header composition, query-string
 * assembly, and error-body propagation. The fetch impl is injected so no
 * network is touched.
 */

import { describe, expect, it } from "vitest";
import { CalendlyApiError, CalendlyClient } from "../calendly-client.js";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface MockResponse {
  status: number;
  body?: unknown;
  text?: string;
}

function mockFetch(
  response: MockResponse,
  capture: CapturedCall[],
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k] = v;
    }
    capture.push({
      url: input,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const payload =
      typeof response.text === "string"
        ? response.text
        : JSON.stringify(response.body);
    return new Response(payload, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("CalendlyClient", () => {
  it("rejects empty access tokens at construction", () => {
    expect(() => new CalendlyClient({ accessToken: "" })).toThrow(
      /non-empty accessToken/,
    );
  });

  it("sends a bearer auth header on getCurrentUser", async () => {
    const capture: CapturedCall[] = [];
    const client = new CalendlyClient({
      accessToken: "tok-123",
      fetchImpl: mockFetch(
        {
          status: 200,
          body: {
            resource: {
              uri: "https://api.calendly.com/users/u1",
              name: "Me",
              slug: "me",
              email: "me@example.com",
              scheduling_url: "https://calendly.com/me",
              timezone: "UTC",
              current_organization: "https://api.calendly.com/organizations/o1",
            },
          },
        },
        capture,
      ),
    });
    const user = await client.getCurrentUser();
    expect(user.slug).toBe("me");
    expect(capture).toHaveLength(1);
    expect(capture[0].headers.Authorization).toBe("Bearer tok-123");
    expect(capture[0].url).toMatch(/\/users\/me$/);
  });

  it("encodes query params on listEventTypes", async () => {
    const capture: CapturedCall[] = [];
    const client = new CalendlyClient({
      accessToken: "tok",
      fetchImpl: mockFetch(
        {
          status: 200,
          body: {
            collection: [],
            pagination: {
              count: 0,
              next_page: null,
              previous_page: null,
              next_page_token: null,
              previous_page_token: null,
            },
          },
        },
        capture,
      ),
    });
    await client.listEventTypes("https://api.calendly.com/users/u1");
    expect(capture).toHaveLength(1);
    const url = new URL(capture[0].url);
    expect(url.searchParams.get("user")).toBe(
      "https://api.calendly.com/users/u1",
    );
    expect(url.searchParams.get("active")).toBe("true");
  });

  it("propagates the response body in errors", async () => {
    const capture: CapturedCall[] = [];
    const client = new CalendlyClient({
      accessToken: "tok",
      fetchImpl: mockFetch(
        {
          status: 401,
          text: '{"title":"Unauthenticated"}',
        },
        capture,
      ),
    });
    await expect(client.getCurrentUser()).rejects.toMatchObject({
      name: "CalendlyApiError",
      status: 401,
    });
    try {
      await client.getCurrentUser();
    } catch (err) {
      expect(err).toBeInstanceOf(CalendlyApiError);
      if (err instanceof CalendlyApiError) {
        expect(err.body).toContain("Unauthenticated");
      }
    }
  });

  it("POSTs cancellation with reason body", async () => {
    const capture: CapturedCall[] = [];
    const client = new CalendlyClient({
      accessToken: "tok",
      fetchImpl: mockFetch({ status: 200, body: {} }, capture),
    });
    await client.cancelScheduledEvent("abc-uuid", "traveling");
    expect(capture).toHaveLength(1);
    expect(capture[0].method).toBe("POST");
    expect(capture[0].url).toMatch(
      /\/scheduled_events\/abc-uuid\/cancellation$/,
    );
    expect(capture[0].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(capture[0].body ?? "{}")).toEqual({
      reason: "traveling",
    });
  });
});
