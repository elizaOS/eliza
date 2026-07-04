// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "../src/lifeops/redact-sensitive-data.js";

/**
 * `redactSensitiveData` sanitizes values before they reach audit events / logs.
 * Getting it wrong leaks credentials or PII into a log line, so the key-matching
 * (exact + substring), email scrubbing, truncation, recursion, and
 * non-mutation all need coverage.
 */

describe("redactSensitiveData", () => {
  it("fully redacts credential keys (exact + substring, case-insensitive)", () => {
    expect(redactSensitiveData({ password: "hunter2" })).toEqual({
      password: "[REDACTED]",
    });
    expect(redactSensitiveData({ token: "abc" }).token).toBe("[REDACTED]");
    expect(
      redactSensitiveData({ Authorization: "Bearer x" }).Authorization,
    ).toBe("[REDACTED]");
    // substring matches
    expect(redactSensitiveData({ accessToken: "x" }).accessToken).toBe(
      "[REDACTED]",
    );
    expect(redactSensitiveData({ userPassword: "x" }).userPassword).toBe(
      "[REDACTED]",
    );
    expect(redactSensitiveData({ clientSecret: "x" }).clientSecret).toBe(
      "[REDACTED]",
    );
  });

  it("redacts email-recipient keys entirely", () => {
    const out = redactSensitiveData({
      to: "a@b.com",
      from: "c@d.com",
      email: "e@f.com",
      cc: "g@h.com",
    });
    expect(out).toEqual({
      to: "[REDACTED]",
      from: "[REDACTED]",
      email: "[REDACTED]",
      cc: "[REDACTED]",
    });
  });

  it("scrubs email addresses out of otherwise-plain strings", () => {
    expect(
      redactSensitiveData({ note: "ping me at alice@example.com today" }).note,
    ).toBe("ping me at [REDACTED_EMAIL] today");
  });

  it("truncates subject and body after redaction", () => {
    const subject = redactSensitiveData({
      subject: "Re: a very very long subject line indeed",
    }).subject as string;
    expect(subject.endsWith("…")).toBe(true);
    expect(subject.length).toBeLessThanOrEqual(21);

    const body = redactSensitiveData({
      body: "x".repeat(200),
    }).body as string;
    expect(body).toContain("[+");
    expect(body).toContain("chars]");
    expect(body.length).toBeLessThan(200);
  });

  it("honors custom subject/body preview lengths", () => {
    const out = redactSensitiveData(
      { subject: "abcdefghij", body: "0123456789" },
      { subjectPreview: 3, bodyPreview: 4 },
    );
    expect(out.subject).toBe("abc…");
    expect(out.body).toBe("0123… [+6 chars]");
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactSensitiveData({
      user: { name: "Bob", email: "bob@x.com", password: "p" },
      toList: ["a@b.com", "c@d.com"],
      meta: { count: 3, ok: true },
    });
    expect(out).toEqual({
      user: { name: "Bob", email: "[REDACTED]", password: "[REDACTED]" },
      toList: ["[REDACTED]", "[REDACTED]"],
      meta: { count: 3, ok: true },
    });
  });

  it("guards against circular references", () => {
    const obj: Record<string, unknown> = { name: "x" };
    obj.self = obj;
    const out = redactSensitiveData(obj) as Record<string, unknown>;
    expect(out.name).toBe("x");
    expect(out.self).toBe("[Circular]");
  });

  it("is non-mutating and passes primitives through", () => {
    const input = { password: "secret", count: 1, flag: false, nil: null };
    const out = redactSensitiveData(input);
    expect(input.password).toBe("secret"); // original intact
    expect(out.count).toBe(1);
    expect(out.flag).toBe(false);
    expect(out.nil).toBeNull();
    expect(redactSensitiveData(42)).toBe(42);
    expect(redactSensitiveData("plain text")).toBe("plain text");
  });
});
