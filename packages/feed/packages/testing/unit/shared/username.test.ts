import { describe, expect, it } from "bun:test";
import {
  isValidOnboardingUsername,
  sanitizeOnboardingUsername,
} from "@feed/shared/utils/username";

describe("sanitizeOnboardingUsername", () => {
  it("keeps an already valid onboarding username", () => {
    expect(sanitizeOnboardingUsername("alice_trader")).toBe("alice_trader");
  });

  it("strips a leading @ and lowercases the username", () => {
    expect(sanitizeOnboardingUsername("@Alice_Trader")).toBe("alice_trader");
  });

  it("replaces unsupported characters with underscores", () => {
    expect(sanitizeOnboardingUsername("alice.eth wow")).toBe("alice_eth_wow");
  });

  it("truncates to the onboarding max length", () => {
    const result = sanitizeOnboardingUsername("ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(result).toBe("abcdefghijklmnopqrst");
    expect(result.length).toBe(20);
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeOnboardingUsername("")).toBe("");
  });

  it("returns empty string when input is only @", () => {
    expect(sanitizeOnboardingUsername("@")).toBe("");
  });

  it("replaces unicode characters with underscores", () => {
    expect(sanitizeOnboardingUsername("田中太郎")).toBe("____");
  });

  it("replaces emoji with underscores", () => {
    expect(sanitizeOnboardingUsername("alice🚀bob")).toBe("alice__bob");
  });

  it("converts all-dot input to underscores", () => {
    expect(sanitizeOnboardingUsername("...")).toBe("___");
  });

  it("strips only the first leading @ symbol", () => {
    expect(sanitizeOnboardingUsername("@@double")).toBe("_double");
  });

  it("strips @ before applying truncation", () => {
    const input = "@abcdefghijklmnopqrstu"; // 22 chars total, 21 after @ strip
    const result = sanitizeOnboardingUsername(input);
    expect(result).toBe("abcdefghijklmnopqrst");
    expect(result.length).toBe(20);
  });
});

describe("isValidOnboardingUsername", () => {
  it("rejects empty string", () => {
    expect(isValidOnboardingUsername("")).toBe(false);
  });

  it("rejects usernames shorter than 3 characters", () => {
    expect(isValidOnboardingUsername("ab")).toBe(false);
  });

  it("rejects all-underscore usernames", () => {
    expect(isValidOnboardingUsername("___")).toBe(false);
    expect(isValidOnboardingUsername("________")).toBe(false);
  });

  it("accepts a valid 3-character username", () => {
    expect(isValidOnboardingUsername("abc")).toBe(true);
  });

  it("accepts a typical username", () => {
    expect(isValidOnboardingUsername("alice_trader")).toBe(true);
  });

  it("accepts a username with underscores mixed with other characters", () => {
    expect(isValidOnboardingUsername("a__b")).toBe(true);
  });

  it("accepts a numeric-only username", () => {
    expect(isValidOnboardingUsername("12345")).toBe(true);
  });
});
