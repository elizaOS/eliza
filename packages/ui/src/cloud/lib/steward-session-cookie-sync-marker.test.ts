import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeStewardServerCookieSynced,
  markStewardServerCookieSynced,
} from "./steward-session-cookie-sync-marker";

describe("Steward server-cookie sync marker", () => {
  beforeEach(() => {
    // Consumption clears both matching and mismatched pending authority.
    consumeStewardServerCookieSynced("");
  });

  it("is one-shot for the exact token", () => {
    markStewardServerCookieSynced("token-a");

    expect(consumeStewardServerCookieSynced("token-a")).toBe(true);
    expect(consumeStewardServerCookieSynced("token-a")).toBe(false);
  });

  it("fails closed and invalidates authority on a token mismatch", () => {
    markStewardServerCookieSynced("token-a");

    expect(consumeStewardServerCookieSynced("token-b")).toBe(false);
    expect(consumeStewardServerCookieSynced("token-a")).toBe(false);
  });
});
