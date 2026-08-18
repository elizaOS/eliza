/**
 * PATCH /api/v1/eliza/google/calendar/events/:eventId used to let
 * request.json() throw into the route-wide catch, which returned 500.
 * Malformed JSON is caller error.
 */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

class AgentGoogleConnectorError extends Error {
  status = 400;
}

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const updateManagedGoogleCalendarEvent = mock(async () => ({
  id: "evt-1",
}));

mock.module("@/lib/services/agent-google-route-deps", () => ({
  agentGoogleRouteDeps: {
    requireAuthOrApiKeyWithOrg,
    updateManagedGoogleCalendarEvent,
    deleteManagedGoogleCalendarEvent: async () => ({ id: "evt-1" }),
    AgentGoogleConnectorError,
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:eventId", route);

describe("PATCH /api/v1/eliza/google/calendar/events/:eventId malformed JSON", () => {
  test("returns 400 instead of 500 and never updates the event", async () => {
    const response = await app.request("/evt-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(updateManagedGoogleCalendarEvent).not.toHaveBeenCalled();
  });

  test("canonical JSON still updates the event", async () => {
    const response = await app.request("/evt-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "standup" }),
    });
    expect(response.status).toBe(200);
    expect(updateManagedGoogleCalendarEvent).toHaveBeenCalled();
  });
});
