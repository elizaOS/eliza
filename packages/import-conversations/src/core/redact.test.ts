/** Unit tests for redactText secret-scrubbing over representative token/key shapes. Deterministic. */

import { describe, expect, it } from "vitest";
import { containsSecret, REDACTED_PLACEHOLDER, redactText } from "./redact.ts";

describe("redactText", () => {
  it("redacts OpenAI sk- keys", () => {
    const out = redactText("my key is sk-abcd1234efgh5678 ok");
    expect(out).toBe(`my key is ${REDACTED_PLACEHOLDER} ok`);
  });

  it("redacts sk-proj- style keys", () => {
    const out = redactText("sk-proj-ABCdef_123-456XYZ done");
    expect(out).toContain(REDACTED_PLACEHOLDER);
    expect(out).not.toContain("sk-proj");
  });

  it("redacts GitHub tokens (ghp_ / gho_ / ghs_)", () => {
    expect(redactText("ghp_0123456789abcdefghijABCDEF")).toBe(
      REDACTED_PLACEHOLDER,
    );
    expect(redactText("gho_0123456789abcdefghijABCDEF")).toBe(
      REDACTED_PLACEHOLDER,
    );
    expect(redactText("ghs_0123456789abcdefghijABCDEF")).toBe(
      REDACTED_PLACEHOLDER,
    );
  });

  it("redacts Bearer tokens", () => {
    const out = redactText("Authorization: Bearer eyJhbGciOi.J9.abc-DEF_123");
    expect(out).toContain(REDACTED_PLACEHOLDER);
    expect(out).not.toContain("eyJhbGciOi");
  });

  it("redacts Slack xox tokens", () => {
    expect(redactText("xoxb-123456789012-abcdEFGH")).toBe(REDACTED_PLACEHOLDER);
    expect(redactText("xoxp-000-111-222abc")).toBe(REDACTED_PLACEHOLDER);
  });

  it("redacts Google AIza keys", () => {
    expect(redactText("AIzaSyD-abcdefghij_KLMNOP12345")).toBe(
      REDACTED_PLACEHOLDER,
    );
  });

  it("redacts AWS access key ids (AKIA / ASIA)", () => {
    expect(redactText("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTED_PLACEHOLDER);
    expect(redactText("ASIAIOSFODNN7EXAMPLE")).toBe(REDACTED_PLACEHOLDER);
  });

  it("redacts PEM private key blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQEA\nabcdEFGH\n-----END RSA PRIVATE KEY-----";
    const out = redactText(`before ${pem} after`);
    expect(out).toBe(`before ${REDACTED_PLACEHOLDER} after`);
  });

  it("leaves clean text untouched", () => {
    const clean = "the quick brown fox jumps over the lazy dog";
    expect(redactText(clean)).toBe(clean);
  });

  it("redacts multiple secrets in one string", () => {
    const out = redactText(
      "sk-abcdefgh12345678 and ghp_0123456789abcdefghij0000",
    );
    expect(out).toBe(`${REDACTED_PLACEHOLDER} and ${REDACTED_PLACEHOLDER}`);
  });

  it("handles empty / falsy input", () => {
    expect(redactText("")).toBe("");
  });

  it("is stable when reusing the global regexes (lastIndex reset)", () => {
    const s = "sk-abcdefgh12345678";
    expect(redactText(s)).toBe(REDACTED_PLACEHOLDER);
    // second call must not miss due to a leftover lastIndex
    expect(redactText(s)).toBe(REDACTED_PLACEHOLDER);
  });
});

describe("containsSecret", () => {
  it("detects a secret", () => {
    expect(containsSecret("here is sk-abcdefgh12345678")).toBe(true);
  });
  it("returns false for clean text", () => {
    expect(containsSecret("nothing to see here")).toBe(false);
  });
  it("returns false for empty", () => {
    expect(containsSecret("")).toBe(false);
  });
});
