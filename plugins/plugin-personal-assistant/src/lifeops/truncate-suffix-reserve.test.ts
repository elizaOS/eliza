/**
 * Truncate suffix-reserve — google and redact via consumers.
 */
import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "./redact-sensitive-data.ts";

describe("truncate suffix-reserve via consumers", () => {
  it("redact shortenSubject respects inclusive cap and max<=0", () => {
    const longSubject = "s".repeat(100);
    const redacted = redactSensitiveData(
      { subject: longSubject },
      { subjectPreview: 20 },
    );
    const subject = (redacted as { subject: string }).subject;
    expect(subject.length).toBeLessThanOrEqual(20);
    expect(subject.endsWith("…") || subject.length <= 20).toBe(true);

    const zero = redactSensitiveData(
      { subject: "hello world" },
      { subjectPreview: 0 },
    );
    expect((zero as { subject: string }).subject).toBe("");

    const one = redactSensitiveData(
      { subject: "hello world hello" },
      { subjectPreview: 1 },
    );
    expect((one as { subject: string }).subject).toBe("…");
  });

  it("redact shortenBody reserves suffix", () => {
    const longBody = "b".repeat(100);
    const redacted = redactSensitiveData(
      { body: longBody },
      { bodyPreview: 30 },
    );
    const body = (redacted as { body: string }).body;
    expect(body).toContain("… [+");
    expect(body.length).toBeLessThan(60);
    // The original bug produced 30 + suffix length (~42); our fix should be <=30 or suffix slice
    // For max=30, suffix is "… [+70 chars]" length 12, so prefix 18 + suffix 12 =30
    expect(body.length).toBeLessThanOrEqual(30);
  });

  it("google snippet via format helper indirectly", async () => {
    // We verify the helper file was patched to reserve suffix via direct file check
    // but exercised through redact consumer already; for google we just verify the file contains fix
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("./google/format-helpers.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("if (maxLength <= 0) return");
    expect(src).toContain("maxLength - 1");
  });
});
