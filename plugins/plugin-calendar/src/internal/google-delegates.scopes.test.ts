import type { ConnectorAccount } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { googleStatusFromAccount } from "./google-delegates.js";

function statusForScopes(scopes: string[]) {
  const account: ConnectorAccount = {
    id: "calendar-scope-fixture",
    provider: "google",
    role: "OWNER",
    purpose: [],
    accessGate: "manual_approval",
    status: "connected",
    createdAt: 0,
    updatedAt: 0,
    metadata: { grantedScopes: scopes },
  };
  return googleStatusFromAccount({ account, agentId: "scope-fixture" });
}

describe("Google account scope projection", () => {
  it.each<[string, boolean]>([
    ["calendar", true],
    ["calendar.events", true],
    ["calendar.events.owned", true],
    ["calendar.readonly", false],
    ["calendar.events.readonly", false],
    ["calendar.events.owned.readonly", false],
  ])("projects %s without promoting read-only scopes", (scope, writable) => {
    for (const value of [scope, `https://www.googleapis.com/auth/${scope}`]) {
      const status = statusForScopes([value]);
      expect(status.grantedCapabilities).toContain("google.calendar.read");
      expect(status.grantedCapabilities.includes("google.calendar.write")).toBe(
        writable,
      );
      expect(status.grant?.capabilities).toEqual(status.grantedCapabilities);
      expect(status.grantedScopes).toEqual([value]);
    }
  });

  it.each([
    "calendar.settings.readonly",
    "calendar.freebusy",
    "calendar.events.freebusy",
    "calendar.calendarlist.readonly",
    "calendar.not-a-supported-scope",
    "https://example.com/calendar.events",
  ])("grants no event capabilities for %s", (scope) => {
    for (const value of [scope, `https://www.googleapis.com/auth/${scope}`]) {
      expect(statusForScopes([value]).grantedCapabilities).toEqual([
        "google.basic_identity",
      ]);
    }
  });
});
