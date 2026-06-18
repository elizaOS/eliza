// Live validation that the Calendly mock/parser matches the REAL API.
//
// Hits the live api.calendly.com with a real personal access token and runs the
// client normalizers against the actual responses, asserting they still produce
// valid DTOs — i.e. the recorded fixture replayed keyless in
// calendly-client.contract.test.ts still matches reality. This is the
// "make sure the mock matches the real API" check.
//
// Gated: needs CALENDLY_LIVE_TEST=1 (or TEST_LANE=post-merge) AND a token
// (CALENDLY_ACCESS_TOKEN or ELIZA_E2E_CALENDLY_ACCESS_TOKEN). Skips cleanly
// otherwise, so a key-less run is a no-op rather than a failure.

import { describe, expect, it } from "vitest";
import {
  type CalendlyCredentials,
  getCalendlyUser,
  listCalendlyEventTypes,
} from "./calendly-client.js";

const TOKEN =
  process.env.CALENDLY_ACCESS_TOKEN ??
  process.env.ELIZA_E2E_CALENDLY_ACCESS_TOKEN ??
  "";
const LIVE =
  (process.env.CALENDLY_LIVE_TEST === "1" ||
    process.env.TEST_LANE === "post-merge") &&
  TOKEN.length > 0;

const creds: CalendlyCredentials = { personalAccessToken: TOKEN };

describe.skipIf(!LIVE)("Calendly v2 — live API parser validation", () => {
  it("live /users/me normalizes into a valid DTO", async () => {
    const user = await getCalendlyUser(creds);
    expect(user.uri).toMatch(/^https:\/\/api\.calendly\.com\/users\//);
    expect(typeof user.name).toBe("string");
    expect(user.email).toContain("@");
    // The field the recorded fixture maps (scheduling_url -> schedulingUrl) must
    // still be present on the real response.
    expect(user.schedulingUrl).toMatch(/^https:\/\/calendly\.com\//);
  }, 30_000);

  it("live /event_types normalizes into valid DTOs", async () => {
    const types = await listCalendlyEventTypes(creds);
    // An account may have zero active event types; assert shape when present.
    for (const t of types) {
      expect(typeof t.uri).toBe("string");
      expect(typeof t.name).toBe("string");
      expect(typeof t.durationMinutes).toBe("number");
      expect(typeof t.active).toBe("boolean");
    }
  }, 30_000);
});
