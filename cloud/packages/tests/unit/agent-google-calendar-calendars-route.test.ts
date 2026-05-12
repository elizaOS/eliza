import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: {
    id: "user-1",
    organization_id: "org-1",
  },
}));

const listManagedGoogleCalendars = mock(async () => [
  {
    calendarId: "quinn@example.com",
    summary: "Quinn",
    description: null,
    primary: false,
    accessRole: "owner",
    backgroundColor: "#16a34a",
    foregroundColor: "#ffffff",
    timeZone: "America/New_York",
    selected: true,
  },
]);

async function importRoute() {
  mock.module("@/lib/services/agent-google-route-deps", () => ({
    agentGoogleRouteDeps: {
      requireAuthOrApiKeyWithOrg,
      listManagedGoogleCalendars,
      AgentGoogleConnectorError: class extends Error {
        constructor(
          public readonly status: number,
          message: string,
        ) {
          super(message);
          this.name = "AgentGoogleConnectorError";
        }
      },
    },
  }));

  return import(
    new URL(
      "../../../apps/api/v1/eliza/google/calendar/calendars/route.ts?test=" + Date.now(),
      import.meta.url,
    ).href
  );
}

describe("managed Google calendar calendars route", () => {
  beforeEach(() => {
    mock.restore();
    requireAuthOrApiKeyWithOrg.mockReset();
    listManagedGoogleCalendars.mockReset();
    requireAuthOrApiKeyWithOrg.mockResolvedValue({
      user: {
        id: "user-1",
        organization_id: "org-1",
      },
    });
    listManagedGoogleCalendars.mockResolvedValue([
      {
        calendarId: "quinn@example.com",
        summary: "Quinn",
        description: null,
        primary: false,
        accessRole: "owner",
        backgroundColor: "#16a34a",
        foregroundColor: "#ffffff",
        timeZone: "America/New_York",
        selected: true,
      },
    ]);
  });

  afterEach(() => {
    mock.restore();
  });

  test("returns managed calendars for the requested side", async () => {
    const { GET } = await importRoute();

    const response = await GET(
      new Request("https://example.com/api/v1/eliza/google/calendar/calendars?side=owner"),
    );

    expect(requireAuthOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(listManagedGoogleCalendars).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      side: "owner",
      grantId: undefined,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({
        calendarId: "quinn@example.com",
        summary: "Quinn",
      }),
    ]);
  });

  test("passes grantId through for account-scoped calendar discovery", async () => {
    const { GET } = await importRoute();

    const response = await GET(
      new Request(
        "https://example.com/api/v1/eliza/google/calendar/calendars?side=owner&grantId=connection-2",
      ),
    );

    expect(listManagedGoogleCalendars).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      side: "owner",
      grantId: "connection-2",
    });
    expect(response.status).toBe(200);
  });

  test("rejects invalid side values", async () => {
    const { GET } = await importRoute();

    const response = await GET(
      new Request("https://example.com/api/v1/eliza/google/calendar/calendars?side=bad"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "side must be owner or agent.",
    });
  });
});
