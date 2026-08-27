/**
 * Unit test for the window-title PII redactor.
 *
 * Materiality: the CC-like detector `(?:\d[ -]?){13,19}` only tolerates a
 * single space/dash separator, so a card number pasted with tab separators
 * (spreadsheet paste) is NOT redacted and the PAN leaves the process. These
 * tests pin the redaction boundaries for emails, phones, and card-like runs,
 * including grouped PANs with doubled separators in every standard PAN length
 * (13/15/16/19) and the no-partial-redaction boundary.
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
    // survive in cleartext: CC_LIKE allows one separator per gap, so the
    // grouped path catches these.
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

  it("redacts non-16-digit grouped PANs (Amex 15, legacy 13)", () => {
    // 4-6-5 Amex layout with doubled spaces.
    expect(redactWindowTitle("3782  822463  10005", {})).toBe("[redacted-cc]");
    // 4-3-3-3 legacy Visa layout with doubled spaces.
    expect(redactWindowTitle("4000  000  000  000", {})).toBe("[redacted-cc]");
  });

  it("consumes the complete 19-digit grouped run (no partial replacement)", () => {
    // A 19-digit 4-4-4-4-3 PAN with doubled spaces: the whole run must be
    // redacted, not just the leading 16 digits with a visible " 111" suffix.
    expect(redactWindowTitle("4111  1111  1111  1111  111", {})).toBe(
      "[redacted-cc]",
    );
  });

  it("leaves 20+-digit grouped runs untouched (no partial redaction)", () => {
    // Outside the 13–19 PAN range: either redact nothing, never half. A
    // partial replacement that reads like redaction is worse than no match.
    expect(redactWindowTitle("4111  1111  1111  1111  1111", {})).toBe(
      "4111  1111  1111  1111  1111",
    );
  });

  it("leaves short digit runs and unrelated numbers alone", () => {
    expect(redactWindowTitle("PIN 12345", {})).toBe("PIN 12345");
    expect(redactWindowTitle("123456789012", {})).toBe("123456789012");
    expect(redactWindowTitle("Build 2026.08.14", {})).toBe("Build 2026.08.14");
  });

  it("leaves dense numeric titles with multi-character separators untouched", () => {
    // 17 digits joined by " - " (three characters per gap): a list of small
    // numbers, not a card run.
    expect(
      redactWindowTitle(
        "1 - 2 - 3 - 4 - 5 - 6 - 7 - 8 - 9 - 10 - 11 - 12 - 13",
        {},
      ),
    ).toBe("1 - 2 - 3 - 4 - 5 - 6 - 7 - 8 - 9 - 10 - 11 - 12 - 13");
    // 14 digits with double-space gaps and uneven group sizes (1–2 digits per
    // group): an arbitrary numeric list, not a grouped PAN (groups must be
    // 3–6 digits), so it stays intact.
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
