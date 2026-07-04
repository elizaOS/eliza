/**
 * Keyless contract test for the Calendly v2 client: replays recorded real-shaped
 * responses (`__fixtures__/calendly-v2.recorded.json` — the documented v2
 * `{resource}` / `{collection,pagination}` envelopes with real field names) through
 * the client normalizers and asserts the produced DTOs, exercising the parser
 * against the real wire shape (scheduling_url, start_time, invitees collection)
 * with no network. `calendly-client.real.test.ts` re-fetches the live API to catch
 * drift from this recording.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CalendlyCredentials,
  getCalendlyUser,
  listCalendlyEventTypes,
  listCalendlyScheduledEvents,
} from "./calendly-client.js";

const recorded = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "__fixtures__/calendly-v2.recorded.json"),
    "utf8",
  ),
) as {
  usersMe: unknown;
  eventTypes: unknown;
  scheduledEvents: unknown;
  invitees: unknown;
};

const creds: CalendlyCredentials = { personalAccessToken: "test-token" };
const ORIGINAL_BASE = process.env.ELIZA_MOCK_CALENDLY_BASE;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.ELIZA_MOCK_CALENDLY_BASE = "https://api.calendly.com";
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/users/me")) return jsonResponse(recorded.usersMe);
    if (url.includes("/event_types")) return jsonResponse(recorded.eventTypes);
    if (url.includes("/invitees")) return jsonResponse(recorded.invitees);
    if (url.includes("/scheduled_events")) {
      return jsonResponse(recorded.scheduledEvents);
    }
    throw new Error(`unexpected Calendly fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_BASE === undefined) delete process.env.ELIZA_MOCK_CALENDLY_BASE;
  else process.env.ELIZA_MOCK_CALENDLY_BASE = ORIGINAL_BASE;
});

describe("Calendly v2 — recorded real API contract", () => {
  it("normalizes the real /users/me {resource} envelope", async () => {
    const user = await getCalendlyUser(creds);
    expect(user.uri).toBe("https://api.calendly.com/users/AAAAAAAAAAAAAAAA");
    expect(user.name).toBe("Ada Lovelace");
    expect(user.email).toBe("ada@example.com");
    // real field scheduling_url -> normalized schedulingUrl
    expect(user.schedulingUrl).toBe("https://calendly.com/ada");
    expect(user.currentOrganization).toContain("/organizations/");
  });

  it("normalizes the real /event_types {collection} envelope", async () => {
    const types = await listCalendlyEventTypes(creds);
    expect(types).toHaveLength(1);
    const t = types[0];
    expect(t?.uri).toContain("/event_types/");
    expect(t?.name).toBe("30 Minute Meeting");
    expect(t?.slug).toBe("30min");
    // real duration -> durationMinutes; scheduling_url -> schedulingUrl
    expect(t?.durationMinutes).toBe(30);
    expect(t?.schedulingUrl).toBe("https://calendly.com/ada/30min");
    expect(t?.active).toBe(true);
  });

  it("normalizes the real /scheduled_events + invitees envelopes", async () => {
    const events = await listCalendlyScheduledEvents(creds, {
      status: "active",
    });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.uri).toContain("/scheduled_events/");
    expect(e?.name).toBe("30 Minute Meeting");
    expect(e?.status).toBe("active");
    // real start_time/end_time -> startTime/endTime
    expect(e?.startTime).toBe("2026-06-20T17:00:00.000000Z");
    expect(e?.endTime).toBe("2026-06-20T17:30:00.000000Z");
    // invitees are fetched from the per-event /invitees collection
    expect(e?.invitees).toHaveLength(1);
    expect(e?.invitees[0]?.email).toBe("grace@example.com");
    expect(e?.invitees[0]?.status).toBe("active");
  });
});
