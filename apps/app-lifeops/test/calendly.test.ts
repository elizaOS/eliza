import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CalendlyError,
  createCalendlySingleUseLink,
  listCalendlyEventTypes,
  readCalendlyCredentialsFromEnv,
} from "../src/lifeops/calendly-client.js";
import { calendlyAction } from "../src/actions/calendly.js";

const ORIGINAL_ENV = { ...process.env };
let originalFetch: typeof fetch;

const SAME_ID = "00000000-0000-0000-0000-000000000001";

function makeRuntime() {
  return { agentId: SAME_ID } as unknown as Parameters<
    NonNullable<typeof calendlyAction.handler>
  >[0];
}

function makeMessage() {
  return {
    entityId: SAME_ID,
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "calendly" },
  } as unknown as Parameters<
    NonNullable<typeof calendlyAction.handler>
  >[1];
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  originalFetch = global.fetch;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("ELIZA_CALENDLY_")) delete process.env[k];
  }
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("readCalendlyCredentialsFromEnv", () => {
  test("returns null when ELIZA_CALENDLY_TOKEN is not set", () => {
    expect(readCalendlyCredentialsFromEnv()).toBeNull();
  });

  test("returns credentials object when token is set", () => {
    process.env.ELIZA_CALENDLY_TOKEN = "tok-123";
    process.env.ELIZA_CALENDLY_USER_URI = "https://api.calendly.com/users/u1";
    const creds = readCalendlyCredentialsFromEnv();
    expect(creds).not.toBeNull();
    expect(creds!.personalAccessToken).toBe("tok-123");
    expect(creds!.userUri).toBe("https://api.calendly.com/users/u1");
  });
});

describe("listCalendlyEventTypes", () => {
  test("paginates via pagination.next_page", async () => {
    const userUri = "https://api.calendly.com/users/u1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/users/me")) {
        return jsonResponse({
          resource: {
            uri: userUri,
            name: "Me",
            email: "me@example.com",
            scheduling_url: "https://calendly.com/me",
          },
        });
      }
      if (url.includes("/event_types") && !url.includes("page_token=p2")) {
        return jsonResponse({
          collection: [
            {
              uri: "et1",
              name: "30min",
              slug: "30min",
              scheduling_url: "https://calendly.com/me/30min",
              duration: 30,
              active: true,
            },
          ],
          pagination: {
            next_page: `${url}&page_token=p2`,
          },
        });
      }
      // page 2
      return jsonResponse({
        collection: [
          {
            uri: "et2",
            name: "60min",
            slug: "60min",
            scheduling_url: "https://calendly.com/me/60min",
            duration: 60,
            active: false,
          },
        ],
        pagination: { next_page: null },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const types = await listCalendlyEventTypes({
      personalAccessToken: "tok",
      userUri,
    });
    expect(types).toHaveLength(2);
    expect(types[0].uri).toBe("et1");
    expect(types[1].uri).toBe("et2");
    // first request to /event_types and the paginated follow-up.
    const eventTypeCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/event_types"),
    );
    expect(eventTypeCalls.length).toBe(2);
  });
});

describe("createCalendlySingleUseLink", () => {
  test("POSTs with Bearer auth, body has max_event_count: 1", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const auth = new Headers(init?.headers as HeadersInit).get(
        "Authorization",
      );
      expect(auth).toBe("Bearer tok-xyz");
      const body = JSON.parse(String(init?.body));
      expect(body.max_event_count).toBe(1);
      expect(body.owner).toBe("https://api.calendly.com/event_types/et1");
      expect(body.owner_type).toBe("EventType");
      void input;
      return jsonResponse({
        resource: {
          booking_url: "https://calendly.com/d/xyz",
          owner: "et1",
          owner_type: "EventType",
        },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await createCalendlySingleUseLink(
      { personalAccessToken: "tok-xyz" },
      "https://api.calendly.com/event_types/et1",
    );
    expect(result.bookingUrl).toBe("https://calendly.com/d/xyz");
    expect(typeof result.expiresAt).toBe("string");
  });
});

describe("CalendlyError on non-2xx", () => {
  test("throws CalendlyError when API returns 4xx", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    await expect(
      createCalendlySingleUseLink(
        { personalAccessToken: "bad" },
        "https://api.calendly.com/event_types/et1",
      ),
    ).rejects.toBeInstanceOf(CalendlyError);
  });
});

describe("calendlyAction", () => {
  test("validate returns false without credentials", async () => {
    const ok = await calendlyAction.validate!(makeRuntime(), makeMessage());
    expect(ok).toBe(false);
  });

  test("list_event_types subaction returns items", async () => {
    process.env.ELIZA_CALENDLY_TOKEN = "tok";
    process.env.ELIZA_CALENDLY_USER_URI = "https://api.calendly.com/users/u1";

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/event_types")) {
        return jsonResponse({
          collection: [
            {
              uri: "et1",
              name: "30min",
              slug: "30min",
              scheduling_url: "https://calendly.com/me/30min",
              duration: 30,
              active: true,
            },
          ],
          pagination: { next_page: null },
        });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const result = await calendlyAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { subaction: "list_event_types" } },
    );
    const r = result as {
      success: boolean;
      data?: { eventTypes?: unknown[] };
    };
    expect(r.success).toBe(true);
    expect(r.data?.eventTypes).toHaveLength(1);
  });
});
