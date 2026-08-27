/**
 * Unit test for the window-title PII redactor.
 *
 * Materiality: the CC-like detector `(?:\\d[ -]?){13,19}` only tolerates a
 * single space/dash separator, so a card number pasted with tab separators
 * (spreadsheet paste) is NOT redacted and the PAN leaves the process. These
 * tests pin the redaction boundaries for emails, phones, and card-like runs.
 */
import { describe, expect, it } from "vitest";
import { redactWindowTitle, resolveRedactorConfigFromEnv } from "./redactor.js";

describe("redactWindowTitle", () => {
  it("passes null/undefined through", () => {
    expect(redactWindowTitle(null, {})).toBeNull();
    expect(redactWindowTitle(undefined, {})).toBeNull();
  });

  it("leaves ordinary titles untouched", () => {
    expect(redactWindowTitle("", {})).toBe("");
    expect(redactWindowTitle("Meeting notes – Q3 planning", {})).toBe(
      "Meeting notes – Q3 planning",
    );
  });

  it("redacts emails", () => {
    expect(redactWindowTitle("Contact user@example.com today", {})).toBe(
      "Contact [redacted-email] today",
    );
    expect(redactWindowTitle("a.b+c-d@sub.domain.co.uk", {})).toBe(
      "[redacted-email]",
    );
  });

  it("redacts US phone formats", () => {
    expect(redactWindowTitle("Call (555) 123-4567 now", {})).toBe(
      "Call [redacted-phone] now",
    );
    expect(redactWindowTitle("555-123-4567", {})).toBe("[redacted-phone]");
    expect(redactWindowTitle("+1 555 123 4567", {})).toBe("[redacted-phone]");
  });

  it("redacts contiguous card-like digit runs", () => {
    expect(redactWindowTitle("4111111111111111", {})).toBe("[redacted-cc]");
    expect(redactWindowTitle("4111 1111 1111 1111", {})).toBe("[redacted-cc]");
    expect(redactWindowTitle("4111-1111-1111-1111", {})).toBe("[redacted-cc]");
  });

  it("redacts card-like runs with single tab separators (spreadsheet paste)", () => {
    expect(redactWindowTitle("4111\t1111\t1111\t1111", {})).toBe(
      "[redacted-cc]",
    );
  });

  it("redacts grouped PANs with doubled separators", () => {
    // A recognizable Visa test PAN pasted with doubled spaces/tabs must not
    // survive in cleartext: CC_LIKE allows one separator per gap, GROUPED_PAN
    // (4x4 digit groups, 1-2 separators) catches these.
    expect(redactWindowTitle("4111  1111  1111  1111", {})).toBe(
      "[redacted-cc]",
    );
    expect(redactWindowTitle("4111\t\t1111\t\t1111\t\t1111", {})).toBe(
      "[redacted-cc]",
    );
    expect(
      redactWindowTitle("Order #4111  1111  1111  1111 confirmed", {}),
    ).toBe("Order #[redacted-cc] confirmed");
  });

  it("leaves short digit runs and unrelated numbers alone", () => {
    expect(redactWindowTitle("PIN 12345", {})).toBe("PIN 12345");
    expect(redactWindowTitle("123456789012", {})).toBe("123456789012");
    expect(redactWindowTitle("Build 2026.08.14", {})).toBe("Build 2026.08.14");
  });

  it("leaves dense numeric titles with multi-character separators untouched", () => {
    // 17 digits joined by " - " (three characters per gap): a list of small
    // numbers, not a card run. At most one separator per gap, so no match.
    expect(
      redactWindowTitle(
        "1 - 2 - 3 - 4 - 5 - 6 - 7 - 8 - 9 - 10 - 11 - 12 - 13",
        {},
      ),
    ).toBe("1 - 2 - 3 - 4 - 5 - 6 - 7 - 8 - 9 - 10 - 11 - 12 - 13");
    // 14 digits with double-space gaps and uneven group sizes: an arbitrary
    // numeric list, not a grouped PAN (GROUPED_PAN requires 4x4), so it
    // stays intact.
    expect(redactWindowTitle("12  7  93  4  55  18  22  31", {})).toBe(
      "12  7  93  4  55  18  22  31",
    );
  });

  it("redacts multiple PII kinds in one title", () => {
    const out = redactWindowTitle(
      "user@example.com 4111 1111 1111 1111 (555) 123-4567",
      {},
    );
    expect(out).toBe("[redacted-email] [redacted-cc] [redacted-phone]");
  });

  it("redacts a card run embedded in surrounding text", () => {
    expect(redactWindowTitle("Order #4111-1111-1111-1111 confirmed", {})).toBe(
      "Order #[redacted-cc] confirmed",
    );
  });
});

describe("resolveRedactorConfigFromEnv", () => {
  it("returns an empty config regardless of env", () => {
    expect(resolveRedactorConfigFromEnv({})).toEqual({});
    expect(resolveRedactorConfigFromEnv({ REDACTOR_TEST_ENV: "x" })).toEqual(
      {},
    );
  });
});
