/**
 * Pins the launch-default unavailable set and the one-notice capability list.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_SECURITY_CAPABILITIES,
  formatCapabilityList,
  listUnavailableAccountSecurityCapabilities,
} from "./account-security-capabilities";

describe("account-security capabilities", () => {
  it("defaults all four launch capabilities to unavailable", () => {
    expect(DEFAULT_ACCOUNT_SECURITY_CAPABILITIES).toEqual({
      sessions: false,
      mfa: false,
      auditLog: false,
      dataExport: false,
    });
    expect(
      listUnavailableAccountSecurityCapabilities(
        DEFAULT_ACCOUNT_SECURITY_CAPABILITIES,
      ),
    ).toEqual(["sessions", "mfa", "auditLog", "dataExport"]);
  });

  it("omits live capabilities from the unavailable list", () => {
    expect(
      listUnavailableAccountSecurityCapabilities({
        sessions: true,
        mfa: false,
        auditLog: false,
        dataExport: true,
      }),
    ).toEqual(["mfa", "auditLog"]);
  });

  it("formats the availability notice as a single English conjunction", () => {
    expect(formatCapabilityList(["session inventory"])).toBe(
      "session inventory",
    );
    expect(formatCapabilityList(["session inventory", "data export"])).toBe(
      "session inventory and data export",
    );
    expect(
      formatCapabilityList([
        "session inventory",
        "two-factor authentication",
        "audit-log reading",
        "data export",
      ]),
    ).toBe(
      "session inventory, two-factor authentication, audit-log reading, and data export",
    );
  });
});
