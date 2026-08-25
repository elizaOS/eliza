/**
 * Deterministic mapping coverage for granted Microsoft Graph scopes onto the
 * normalized multi-domain capability catalog. Pure-function tests; no network
 * or storage involved.
 */

import { describe, expect, it } from "vitest";
import { capabilitiesForScopes } from "./accounts.js";

describe("capabilitiesForScopes", () => {
  it("derives identity and calendar capabilities as before", () => {
    expect(
      new Set(
        capabilitiesForScopes(["openid", "User.Read", "Calendars.ReadWrite"]),
      ),
    ).toEqual(
      new Set([
        "microsoft.basic_identity",
        "microsoft.calendar.read_basic",
        "microsoft.calendar.freebusy",
        "microsoft.calendar.read",
        "microsoft.calendar.write",
      ]),
    );
  });

  it("derives mail triage from read and manage from readwrite grants", () => {
    expect(capabilitiesForScopes(["Mail.Read"])).toEqual([
      "microsoft.mail.triage",
    ]);
    expect(new Set(capabilitiesForScopes(["Mail.ReadWrite.Shared"]))).toEqual(
      new Set(["microsoft.mail.triage", "microsoft.mail.manage"]),
    );
    expect(capabilitiesForScopes(["Mail.Send"])).toEqual([
      "microsoft.mail.send",
    ]);
  });

  it("derives contacts and files read capabilities including write grants", () => {
    expect(capabilitiesForScopes(["Contacts.ReadWrite"])).toEqual([
      "microsoft.contacts.read",
    ]);
    expect(capabilitiesForScopes(["Files.Read.All"])).toEqual([
      "microsoft.files.read",
    ]);
    expect(
      capabilitiesForScopes(["https://graph.microsoft.com/Files.ReadWrite"]),
    ).toEqual(["microsoft.files.read"]);
  });

  it("yields no capability for unknown or empty scope input", () => {
    expect(capabilitiesForScopes([])).toEqual([]);
    expect(capabilitiesForScopes(["Sites.Read.All", "not-a-scope"])).toEqual(
      [],
    );
  });
});
