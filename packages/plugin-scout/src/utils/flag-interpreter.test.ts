import { describe, it, expect } from "vitest";
import {
  interpretFlag,
  interpretFlags,
  getWarningFlags,
  hasAutoRejectFlag,
  formatFlagsForDisplay,
} from "./flag-interpreter.js";

describe("interpretFlag", () => {
  it("returns known flag info for WALLET_SPAM_FARM", () => {
    const info = interpretFlag("WALLET_SPAM_FARM");
    expect(info.flag).toBe("WALLET_SPAM_FARM");
    expect(info.severity).toBe("critical");
    expect(info.description).toContain("spam farm");
  });

  it("returns known flag info for PROTOCOL_COMPLIANT", () => {
    const info = interpretFlag("PROTOCOL_COMPLIANT");
    expect(info.severity).toBe("info");
  });

  it("returns medium severity for unknown flags", () => {
    const info = interpretFlag("SOME_NEW_FLAG");
    expect(info.flag).toBe("SOME_NEW_FLAG");
    expect(info.severity).toBe("medium");
    expect(info.description).toContain("Unknown flag");
  });
});

describe("interpretFlags", () => {
  it("interprets multiple flags", () => {
    const result = interpretFlags(["ENDPOINT_DOWN", "PROTOCOL_COMPLIANT"]);
    expect(result).toHaveLength(2);
    expect(result[0].severity).toBe("critical");
    expect(result[1].severity).toBe("info");
  });

  it("returns empty array for empty input", () => {
    expect(interpretFlags([])).toEqual([]);
  });
});

describe("getWarningFlags", () => {
  it("returns only critical and high severity flags", () => {
    const result = getWarningFlags([
      "WALLET_SPAM_FARM",  // critical
      "TEMPLATE_SPAM",     // high
      "ENDPOINT_TIMEOUT",  // medium
      "PROTOCOL_COMPLIANT", // info
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].flag).toBe("WALLET_SPAM_FARM");
    expect(result[1].flag).toBe("TEMPLATE_SPAM");
  });

  it("returns empty for info-only flags", () => {
    expect(getWarningFlags(["PROTOCOL_COMPLIANT", "X402_V1"])).toEqual([]);
  });
});

describe("hasAutoRejectFlag", () => {
  it("returns true when a flag is in the reject list", () => {
    expect(
      hasAutoRejectFlag(
        ["ENDPOINT_DOWN", "PROTOCOL_COMPLIANT"],
        ["WALLET_SPAM_FARM", "ENDPOINT_DOWN"]
      )
    ).toBe(true);
  });

  it("returns false when no flags match", () => {
    expect(
      hasAutoRejectFlag(
        ["PROTOCOL_COMPLIANT"],
        ["WALLET_SPAM_FARM", "ENDPOINT_DOWN"]
      )
    ).toBe(false);
  });

  it("returns false for empty flags", () => {
    expect(hasAutoRejectFlag([], ["WALLET_SPAM_FARM"])).toBe(false);
  });

  it("returns false for empty reject list", () => {
    expect(hasAutoRejectFlag(["ENDPOINT_DOWN"], [])).toBe(false);
  });
});

describe("formatFlagsForDisplay", () => {
  it("returns 'No flags.' for empty array", () => {
    expect(formatFlagsForDisplay([])).toBe("No flags.");
  });

  it("shows warnings for critical/high flags", () => {
    const result = formatFlagsForDisplay(["WALLET_SPAM_FARM"]);
    expect(result).toContain("Warnings:");
    expect(result).toContain("WALLET_SPAM_FARM");
  });

  it("shows positives for info flags", () => {
    const result = formatFlagsForDisplay(["PROTOCOL_COMPLIANT"]);
    expect(result).toContain("Positives:");
    expect(result).toContain("PROTOCOL_COMPLIANT");
  });

  it("shows both warnings and positives", () => {
    const result = formatFlagsForDisplay(["ENDPOINT_DOWN", "X402_V1"]);
    expect(result).toContain("Warnings:");
    expect(result).toContain("Positives:");
  });

  it("omits medium severity from display", () => {
    const result = formatFlagsForDisplay(["ENDPOINT_TIMEOUT"]);
    // Medium severity is neither in warnings nor positives
    expect(result).not.toContain("Warnings:");
    expect(result).not.toContain("Positives:");
    // But it's not "No flags." either since the array is non-empty
    // The function returns empty string when no warnings and no info
    expect(result).toBe("");
  });
});