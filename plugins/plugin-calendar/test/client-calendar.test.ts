/**
 * Unit tests for the calendar client methods that `client-calendar.ts` augments
 * onto the `@elizaos/ui` `ElizaClient` prototype. `@elizaos/ui` is mocked so the
 * suite stays node-safe; we assert each method issues the right verb, path, and
 * query/body against a spied `fetch`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { FakeElizaClient } = vi.hoisted(() => {
  class FakeElizaClient {
    fetch = vi.fn(async () => ({}) as never);
  }
  return { FakeElizaClient };
});

vi.mock("@elizaos/ui", () => ({ ElizaClient: FakeElizaClient }));

// Import for its side effect: augments FakeElizaClient.prototype.
import "../src/api/client-calendar.js";

type AugmentedClient = FakeElizaClient & {
  getLifeOpsCalendarFeed: (o?: object) => Promise<unknown>;
  getLifeOpsCalendars: (o?: object) => Promise<unknown>;
  setLifeOpsCalendarIncluded: (d: object) => Promise<unknown>;
  getLifeOpsNextCalendarEventContext: (o?: object) => Promise<unknown>;
  createLifeOpsCalendarEvent: (d: object) => Promise<unknown>;
  updateLifeOpsCalendarEvent: (id: string, p: object) => Promise<unknown>;
  deleteLifeOpsCalendarEvent: (id: string, o?: object) => Promise<unknown>;
};

let client: AugmentedClient;

beforeEach(() => {
  client = new FakeElizaClient() as AugmentedClient;
});

describe("calendar client methods", () => {
  it("getLifeOpsCalendarFeed builds the feed path with a query", async () => {
    await client.getLifeOpsCalendarFeed({
      timeMin: "2026-05-12T00:00:00.000Z",
      timeMax: "2026-05-13T00:00:00.000Z",
      grantId: "g1",
    });
    const path = client.fetch.mock.calls[0][0] as string;
    expect(path).toContain("/api/lifeops/calendar/feed?");
    expect(path).toContain("timeMin=");
    expect(path).toContain("grantId=g1");
  });

  it("getLifeOpsCalendars hits the calendars path", async () => {
    await client.getLifeOpsCalendars();
    expect(client.fetch.mock.calls[0][0]).toContain(
      "/api/lifeops/calendar/calendars",
    );
  });

  it("setLifeOpsCalendarIncluded PUTs to the include path", async () => {
    await client.setLifeOpsCalendarIncluded({
      calendarId: "work@x",
      includeInFeed: false,
    });
    const [path, init] = client.fetch.mock.calls[0] as [string, RequestInit];
    expect(path).toContain("/api/lifeops/calendar/calendars/work%40x/include");
    expect(init.method).toBe("PUT");
  });

  it("createLifeOpsCalendarEvent POSTs the body", async () => {
    await client.createLifeOpsCalendarEvent({ title: "Dentist" });
    const [path, init] = client.fetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/lifeops/calendar/events");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("Dentist");
  });

  it("updateLifeOpsCalendarEvent PATCHes the encoded event path", async () => {
    await client.updateLifeOpsCalendarEvent("evt/1", { title: "x" });
    const [path, init] = client.fetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/lifeops/calendar/events/evt%2F1");
    expect(init.method).toBe("PATCH");
  });

  it("deleteLifeOpsCalendarEvent DELETEs with the side query", async () => {
    await client.deleteLifeOpsCalendarEvent("evt-1", { side: "owner" });
    const [path, init] = client.fetch.mock.calls[0] as [string, RequestInit];
    expect(path).toContain("/api/lifeops/calendar/events/evt-1?side=owner");
    expect(init.method).toBe("DELETE");
  });
});
