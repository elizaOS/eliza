import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "./redact-sensitive-data.js";

describe("redactSensitiveData", () => {
  it("redacts credential-shaped keys outright", () => {
    const out = redactSensitiveData({
      password: "hunter2",
      token: "abc.def.ghi",
      secret: "shh",
      apiKey: "sk-live-…",
      authorization: "Bearer xyz",
    });
    expect(out).toEqual({
      password: "[REDACTED]",
      token: "[REDACTED]",
      secret: "[REDACTED]",
      apiKey: "[REDACTED]",
      authorization: "[REDACTED]",
    });
  });

  it("redacts email-like fields", () => {
    const out = redactSensitiveData({
      from: "alice@example.com",
      to: ["bob@example.com"],
      fromEmail: "carol@example.com",
      toList: ["dan@example.com"],
      replyTo: "ed@example.com",
      cc: "fred@example.com",
    });
    expect(out).toEqual({
      from: "[REDACTED]",
      to: ["[REDACTED]"],
      fromEmail: "[REDACTED]",
      toList: ["[REDACTED]"],
      replyTo: "[REDACTED]",
      cc: "fred@example.com",
    });
  });

  it("shortens subject to a 20-char preview by default", () => {
    const out = redactSensitiveData({
      subject: "this is a very long subject line that should be shortened",
    });
    expect((out as { subject: string }).subject.length).toBeLessThanOrEqual(21);
    expect((out as { subject: string }).subject).toMatch(/…$/);
  });

  it("shortens body / snippet with a length suffix", () => {
    const longBody = "x".repeat(120);
    const out = redactSensitiveData({ body: longBody, snippet: longBody });
    expect((out as { body: string }).body).toMatch(/\[\+90 chars\]$/);
    expect((out as { snippet: string }).snippet).toMatch(/\[\+90 chars\]$/);
  });

  it("walks nested arrays and objects", () => {
    const out = redactSensitiveData({
      messages: [
        {
          subject: "A".repeat(50),
          body: "B".repeat(50),
          from: "x@y.com",
          score: 0.9,
        },
      ],
    });
    const message = (out as { messages: { score: number; from: string }[] })
      .messages[0];
    expect(message.score).toBe(0.9);
    expect(message.from).toBe("[REDACTED]");
  });

  it("preserves non-sensitive scalars", () => {
    const out = redactSensitiveData({
      messageId: "abc123",
      sentMessageId: "xyz",
      affectedCount: 42,
      destructive: false,
    });
    expect(out).toEqual({
      messageId: "abc123",
      sentMessageId: "xyz",
      affectedCount: 42,
      destructive: false,
    });
  });

  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redactSensitiveData(a)).not.toThrow();
  });
});
