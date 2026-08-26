/**
 * Contract tests for the window-title PII redactor (redactWindowTitle).
 * Pins the privacy boundary documented in redactor.ts: credit-card-like runs
 * redact before phone patterns (a 16-digit PAN must not partially match the
 * phone regex), email addresses strip, and benign digit runs pass through
 * unchanged. Deterministic — pure function, real regexes, no mocks.
 */
import { describe, expect, it } from "vitest";
import { redactWindowTitle } from "./redactor.js";

describe("redactWindowTitle: credit-card runs", () => {
  // The CC pattern (?:\d[ -]?){13,19} also consumes ONE trailing separator
  // after the final digit ("4111111111111111 -" matches), so a single space
  // before the next word is eaten by the replacement. These expectations pin
  // that behavior: the PAN itself is fully redacted either way.
  it("redacts a contiguous 16-digit PAN before the phone pattern can match", () => {
    expect(redactWindowTitle("Card 4111111111111111 - Bank", {})).toBe(
      "Card [redacted-cc]- Bank",
    );
  });

  it("redacts a separator-spaced PAN (the phone regex sees 4-digit groups)", () => {
    expect(redactWindowTitle("Card 4111 1111 1111 1111 - Bank", {})).toBe(
      "Card [redacted-cc]- Bank",
    );
  });

  it("redacts a dash-separated PAN", () => {
    expect(redactWindowTitle("Amex 3782-822463-10005 verified", {})).toBe(
      "Amex [redacted-cc]verified",
    );
  });

  it("redacts the minimum 13-digit run", () => {
    expect(redactWindowTitle("ref 1234567890123 ok", {})).toBe(
      "ref [redacted-cc]ok",
    );
  });

  it("redacts the maximum 19-digit run", () => {
    expect(redactWindowTitle("ref 1234567890123456789 ok", {})).toBe(
      "ref [redacted-cc]ok",
    );
  });

  it("does not redact a 12-digit run", () => {
    expect(redactWindowTitle("Invoice 123456789012 paid", {})).toBe(
      "Invoice 123456789012 paid",
    );
  });
});

describe("redactWindowTitle: precedence and PAN reassembly", () => {
  it("redacts a separator PAN that would otherwise reassemble as a US phone", () => {
    // 415-496-0148-2211 is a 16-digit run with phone-shaped prefix groups.
    // CC must win and consume the whole run.
    expect(redactWindowTitle("Acct 415-496-0148-2211 statement", {})).toBe(
      "Acct [redacted-cc]statement",
    );
  });

  it("redacts a phone-shaped 10-digit prefix only when the full run is under CC range", () => {
    // 10 digits: phone territory, not CC — phone pattern owns it.
    expect(redactWindowTitle("Call 415-496-0148 now", {})).toBe(
      "Call [redacted-phone] now",
    );
  });

  it("redacts email, phone, and PAN classes in one mixed title", () => {
    expect(
      redactWindowTitle(
        "Mail john.smith@example.com or call (415) 496-0148 - card 4111111111111111",
        {},
      ),
    ).toBe(
      "Mail [redacted-email] or call [redacted-phone] - card [redacted-cc]",
    );
  });
});

describe("redactWindowTitle: emails", () => {
  it("redacts a simple email", () => {
    expect(redactWindowTitle("Invoice to john@example.com - Gmail", {})).toBe(
      "Invoice to [redacted-email] - Gmail",
    );
  });

  it("redacts a punctuation-bearing local part", () => {
    expect(
      redactWindowTitle("draft to first.last+tag@sub.example.co.uk", {}),
    ).toBe("draft to [redacted-email]");
  });

  it("does not redact a bare @ without an email domain shape", () => {
    expect(redactWindowTitle("user @ host mention", {})).toBe(
      "user @ host mention",
    );
  });
});

describe("redactWindowTitle: phones", () => {
  it("redacts an E.164 number", () => {
    expect(redactWindowTitle("Call +441514960148 back", {})).toBe(
      "Call [redacted-phone] back",
    );
  });

  it("redacts a 10-digit US number with parentheses and dashes", () => {
    expect(redactWindowTitle("Call (415) 496-0148 back", {})).toBe(
      "Call [redacted-phone] back",
    );
  });

  it("redacts a dot-separated US number", () => {
    expect(redactWindowTitle("Call 415.496.0148 back", {})).toBe(
      "Call [redacted-phone] back",
    );
  });

  it("redacts a +1-prefixed US number", () => {
    expect(redactWindowTitle("Call +1 415 496 0148 back", {})).toBe(
      "Call [redacted-phone] back",
    );
  });

  it("does not redact a short 7-digit local number", () => {
    expect(redactWindowTitle("Extension 4960148", {})).toBe(
      "Extension 4960148",
    );
  });
});

describe("redactWindowTitle: benign pass-through", () => {
  it("returns PII-free titles unchanged", () => {
    const title = "eliza - redactor.ts - elizaOS";
    expect(redactWindowTitle(title, {})).toBe(title);
  });

  it("keeps timestamps and ordinary numbers visible", () => {
    expect(redactWindowTitle("Meet at 14:30 (room 42)", {})).toBe(
      "Meet at 14:30 (room 42)",
    );
  });

  it("returns null for null and undefined titles", () => {
    expect(redactWindowTitle(null, {})).toBeNull();
    expect(redactWindowTitle(undefined, {})).toBeNull();
  });
});

describe("redactWindowTitle: global replacement", () => {
  // The consumer reports every captured window title in the interval; a
  // non-global regex would redact only the first occurrence of each class
  // and leak the rest into the activity report.
  it("redacts every occurrence of each PII class in one title", () => {
    const redacted = redactWindowTitle(
      "mail a@one.com and b@two.com, call 4154960148 or 4154960149, card 4111111111111111 / 5555555555554444",
      {},
    );
    expect(redacted).toBe(
      "mail [redacted-email] and [redacted-email], call [redacted-phone] or [redacted-phone], card [redacted-cc]/ [redacted-cc]",
    );
  });

  it("treats digit-adjacent phone pairs as one CC-shaped run (over-redaction, not leakage)", () => {
    // Two 10-digit phones separated only by a space form a 20-digit run; the
    // greedy CC match consumes up to 19 digits before the phone pass runs.
    // Current behavior over-redacts (privacy-safe) and can leave one stray
    // digit — pinned here so a change to that shape is a conscious decision.
    const redacted = redactWindowTitle("4154960148 4154960149", {});
    expect(redacted).toBe("[redacted-cc]9");
  });

  it("leaves no raw digits behind after redaction for PAN-dense titles", () => {
    const redacted = redactWindowTitle(
      "4111111111111111 and 4111111111111111",
      {},
    );
    expect(redacted).not.toMatch(/\d{4}/);
  });
});
