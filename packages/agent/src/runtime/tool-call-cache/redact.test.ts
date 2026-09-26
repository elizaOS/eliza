import { describe, expect, it } from "vitest";
import { defaultPrivacyRedactor } from "./redact.ts";

// Samples are assembled from fragments so this file never contains a literal
// that push protection recognises as a live credential.
const sample = (...parts: string[]): string => parts.join("");

describe("defaultPrivacyRedactor credential shapes", () => {
  it.each([
    [sample("ASIA", "IOSFODNN7EXAMPLE"), "aws-access-key"],
    [sample("ABIA", "IOSFODNN7EXAMPLE"), "aws-access-key"],
    [sample("ACCA", "IOSFODNN7EXAMPLE"), "aws-access-key"],
    [
      sample("github", "_pat_", "11ABCDEFG0abcdefghij_ABCDEFGHIJKLMNOP"),
      "github-token",
    ],
    [
      sample("xox", "b-", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt"),
      "slack-token",
    ],
    [sample("ya29", ".", "a0AfH6SMBabcdefghijklmnop"), "google-oauth-token"],
  ])("redacts %s", (secret, label) => {
    const out = defaultPrivacyRedactor(`token ${secret}`) as string;
    expect(out).toContain(`<REDACTED:${label}>`);
    expect(out).not.toContain(secret);
  });

  it("does not fold ordinary prose into the AWS credential shape", () => {
    const prose = "Asia and the Pacific region ACCA membership notes";
    expect(defaultPrivacyRedactor(prose)).toBe(prose);
  });
});
