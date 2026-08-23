/**
 * Coverage for voice.
 */
import { describe, expect, it } from "vitest";
import {
  hasConfiguredApiKey,
  REALTIME_VOICE_CLIENT_TRANSPORT,
  sanitizeApiKey,
} from "./voice.js";

describe("voice", () => {
  it("exposes transport", () => {
    expect(REALTIME_VOICE_CLIENT_TRANSPORT).toBe("realtime_voice");
  });
  it("sanitizes api key", () => {
    expect(sanitizeApiKey(undefined)).toBeUndefined();
    expect(sanitizeApiKey("short")).toBe("short");
    expect(sanitizeApiKey("  key123456789  ")).toContain("...");
    expect(sanitizeApiKey("[REDACTED]")).toBe("[REDACTED]");
  });
  it("checks configured", () => {
    expect(hasConfiguredApiKey("abc")).toBe(true);
    expect(hasConfiguredApiKey(undefined)).toBe(false);
    expect(hasConfiguredApiKey("[REDACTED]")).toBe(false);
  });
});
