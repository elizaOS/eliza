/**
 * Contract tests for the window-title PII redactor (redactWindowTitle).
 * Pins the privacy boundary documented in redactor.ts: credit-card-like runs
 * (12+ digits — the ISO/IEC 7812 PAN floor) redact before phone patterns (a
 * 16-digit PAN must not partially match the phone regex), the separator class
 * covers the separators a real browser title carries, long digit runs redact
 * in full (an exempted long match could embed a valid PAN), newline never
 * combines digit groups, email addresses strip, and benign digit runs stay
 * visible. Deterministic — pure function, real regexes, no mocks.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { redactWindowTitle, resolveRedactorConfigFromEnv } from "./redactor.js";

describe("redactWindowTitle: credit-card runs", () => {
  // The CC pattern matches digit runs joined by separator runs BETWEEN
  // digits only, so text after the final digit (" - Bank", " verified")
  // survives verbatim and the placeholder lands exactly where the PAN was.
  it("redacts a contiguous 16-digit PAN before the phone pattern can match", () => {
    expect(redactWindowTitle("Card 4111111111111111 - Bank", {})).toBe(
      "Card [redacted-cc] - Bank",
    );
  });

  it("redacts a separator-spaced PAN (the phone regex sees 4-digit groups)", () => {
    expect(redactWindowTitle("Card 4111 1111 1111 1111 - Bank", {})).toBe(
      "Card [redacted-cc] - Bank",
    );
  });

  it("redacts a dash-separated PAN", () => {
    expect(redactWindowTitle("Amex 3782-822463-10005 verified", {})).toBe(
      "Amex [redacted-cc] verified",
    );
  });

  it("redacts the minimum 12-digit run (ISO/IEC 7812 PAN floor)", () => {
    // 12 is the floor of the ISO/IEC 7812 PAN length range (Maestro has
    // issued 12-digit PANs). A 12-digit run must fail closed: a report
    // consumer cannot distinguish a benign 12-digit reference from a PAN
    // after this boundary has declared the title safe.
    expect(redactWindowTitle("Card 501234567890 - Bank", {})).toBe(
      "Card [redacted-cc] - Bank",
    );
  });

  it("redacts a 12-digit run in a reference-shaped title", () => {
    expect(redactWindowTitle("Invoice 123456789012 paid", {})).toBe(
      "Invoice [redacted-cc] paid",
    );
  });

  it("redacts the maximum 19-digit run", () => {
    expect(redactWindowTitle("ref 1234567890123456789 ok", {})).toBe(
      "ref [redacted-cc] ok",
    );
  });

  it("redacts a >19-digit run in full rather than exempting an embedded PAN", () => {
    // A maximal match may be a valid PAN concatenated with another numeric
    // field (here: 16-digit PAN + "/2024" expiry). Passing the 20-digit
    // match through would leak the embedded PAN, so long runs redact whole.
    expect(redactWindowTitle("Card 4111 1111 1111 1111/2024", {})).toBe(
      "Card [redacted-cc]",
    );
  });

  it("does not redact an 11-digit run", () => {
    // Below the ISO/IEC 7812 PAN floor: 11-digit runs are not card-shaped,
    // and redacting them would strip ordinary short references. The 12-digit
    // ISO floor, not readability, is the cutoff.
    expect(redactWindowTitle("Call 44151496014 back", {})).toBe(
      "Call 44151496014 back",
    );
  });
});

describe("redactWindowTitle: PAN separators a browser title carries", () => {
  // A browser <title> routinely contains &nbsp; (U+00A0) between digit
  // groups; bank sites also format card numbers with dots, commas, or
  // slashes. The separator class must cover every spelling a real title
  // can carry, or the full PAN survives redaction.
  it.each([
    ["space", "Card 4111 1111 1111 1111 - Bank"],
    ["hyphen", "Card 4111-1111-1111-1111 - Bank"],
    ["dot", "Card 4111.1111.1111.1111 - Bank"],
    ["comma", "Card 4111,1111,1111,1111 - Bank"],
    ["slash", "Card 4111/1111/1111/1111 - Bank"],
    ["tab (U+0009)", "Card 4111\t1111\t1111\t1111 - Bank"],
    ["no-break space (U+00A0)", "Card 4111 1111 1111 1111 - Bank"],
    ["en dash (U+2013)", "Card 4111–1111–1111–1111 - Bank"],
    ["em dash (U+2014)", "Card 4111—1111—1111—1111 - Bank"],
    ["hyphen (U+2010)", "Card 4111‐1111‐1111‐1111 - Bank"],
    ["non-breaking hyphen (U+2011)", "Card 4111‑1111‑1111‑1111 - Bank"],
    ["figure dash (U+2012)", "Card 4111‒1111‒1111‒1111 - Bank"],
    ["full-width hyphen (U+FF0D)", "Card 4111－1111－1111－1111 - Bank"],
    ["double space", "Card 4111  1111  1111  1111 - Bank"],
    ["space-hyphen-space", "Card 4111 - 1111 - 1111 - 1111 - Bank"],
    ["Arabic-Indic digits (U+0660-0669)", "Card ٤١١١ ١١١١ ١١١١ ١١١١ - Bank"],
    [
      "fullwidth digits (U+FF10-FF19)",
      "Card ４１１１－１１１１－１１１１－１１１１ - Bank",
    ],
    ["minus sign separator (U+2212)", "Card 4111−1111−1111−1111 - Bank"],
    ["soft hyphen separator (U+00AD)", "Card 4111­1111­1111­1111 - Bank"],
    ["zero-width space (U+200B)", "Card 4111​1111​1111​1111 - Bank"],
    ["fraction slash (U+2044)", "Card 4111⁄1111⁄1111⁄1111 - Bank"],
    ["division slash (U+2215)", "Card 4111∕1111∕1111∕1111 - Bank"],
    ["zero-width non-joiner (U+200C)", "Card 4111‌1111‌1111‌1111 - Bank"],
    ["zero-width joiner (U+200D)", "Card 4111‍1111‍1111‍1111 - Bank"],
    ["left-to-right mark (U+200E)", "Card 4111‎1111‎1111‎1111 - Bank"],
    ["right-to-left mark (U+200F)", "Card 4111‏1111‏1111‏1111 - Bank"],
    ["Arabic letter mark (U+061C)", "Card 4111؜1111؜1111؜1111 - Bank"],
    ["combining grapheme joiner (U+034F)", "Card 4111͏1111͏1111͏1111 - Bank"],
    ["variation selector-16 (U+FE0F)", "Card 4111️1111️1111️1111 - Bank"],
    ["word joiner (U+2060)", "Card 4111⁠1111⁠1111⁠1111 - Bank"],
    [
      "zero-width no-break space / BOM (U+FEFF)",
      "Card 4111﻿1111﻿1111﻿1111 - Bank",
    ],
  ])("redacts a PAN separated by %s", (_name, title) => {
    // Exact string: proves the WHOLE run is consumed — a partially-redacted
    // tail like "Card [redacted-cc]111 - Bank" must fail this row.
    expect(redactWindowTitle(title, {})).toBe("Card [redacted-cc] - Bank");
  });
});

describe("redactWindowTitle: runs longer than 19 digits", () => {
  // Long digit runs redact WHOLE. Two failure modes are pinned here: (a) a
  // quantifier cap {13,19} partially redacts and strands a digit tail
  // (x [redacted-cc]0123456 y), and (b) an exemption-style guard that
  // passes >19-digit matches through untouched leaks an embedded valid PAN
  // when the match is a PAN concatenated with another numeric field.
  it("redacts a 20-digit run in full", () => {
    expect(redactWindowTitle("Order 12345678901234567890 shipped", {})).toBe(
      "Order [redacted-cc] shipped",
    );
  });

  it("redacts a 26-digit run in full with no stranded digit tail", () => {
    expect(redactWindowTitle("ref 12345678901234567890123456 ok", {})).toBe(
      "ref [redacted-cc] ok",
    );
  });

  it("redacts a >19-digit separator-spaced run in full", () => {
    expect(redactWindowTitle("ids 1234 5678 9012 3456 7890 end", {})).toBe(
      "ids [redacted-cc] end",
    );
  });

  it("completes an 11-digit near-match with repeated separators without hanging", async () => {
    // ReDoS regression: an earlier separator alternation with overlapping
    // branches (ZWJ \p{Cf} + \p{Default_Ignorable_Code_Point}; variation
    // selectors \p{M} + DICP) backtracked exponentially on a NEAR-match —
    // a run of exactly 11 digits (one short of the 12-digit floor) with
    // repeated U+200B after the first digit: 20 repetitions took ~480ms, 40
    // took ~1.7s, and more would hang. A synchronous regex blocks the event
    // loop, so an in-process timer cannot interrupt it; the probe therefore
    // runs the regex extracted from the module source in a CHILD PROCESS
    // with a hard wall-clock deadline. The vulnerable shape gets killed at
    // the deadline and fails this test; the single union character class
    // matches in ~0ms.
    const nearMatch = `Card 4${"\u200B".repeat(60)}1111111111 - Bank`;
    // The child owns BOTH assertions (deadline-protected): a regressed shape
    // is killed at the deadline and this test fails cleanly instead of
    // hanging the worker — so there is deliberately no in-process call on
    // this input.
    const source = readFileSync(
      fileURLToPath(new URL("./redactor.ts", import.meta.url)),
      "utf8",
    );
    const ccLike = source.match(/const CC_LIKE =\s*\n?\s*(\/[^\n]+\/gu);/);
    expect(ccLike, "CC_LIKE literal not found in redactor.ts").not.toBeNull();
    const probe = `
      const re = ${ccLike?.[1] as string};
      const title = ${JSON.stringify(nearMatch)};
      const t0 = Date.now();
      const out = title.replace(re, "[redacted-cc]");
      process.stdout.write(JSON.stringify({ ms: Date.now() - t0, out }));
    `;
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(process.execPath, ["-e", probe], {
      timeout: 5000,
    });
    const { ms, out } = JSON.parse(stdout) as { ms: number; out: string };
    // The pre-fix shape needs >5s at 60 repetitions (killed at the deadline,
    // which rejects and fails this test). Keep a generous CI margin below it.
    expect(ms).toBeLessThan(4000);
    expect(out).toBe(nearMatch);
  });

  it("does not combine digit groups across a newline", () => {
    // Vertical whitespace breaks a run: unrelated digit groups on separate
    // lines of a title must not total up to a CC match.
    expect(redactWindowTitle("a 1234\n5678 9012 345 b", {})).toBe(
      "a 1234\n5678 9012 345 b",
    );
  });
});

describe("redactWindowTitle: precedence and PAN reassembly", () => {
  it("redacts a separator PAN that would otherwise reassemble as a US phone", () => {
    // 415-496-0148-2211 is a 16-digit run with phone-shaped prefix groups.
    // CC must win and consume the whole run.
    expect(redactWindowTitle("Acct 415-496-0148-2211 statement", {})).toBe(
      "Acct [redacted-cc] statement",
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
  it("redacts an E.164 number under the CC floor", () => {
    // +44151496014 is 11 digits — phone territory. At the 12-digit CC floor
    // a 12-digit E.164 number is card-shaped and the CC pass wins (pinned
    // in the credit-card describe block); the phone pattern owns only
    // shorter E.164 numbers now.
    expect(redactWindowTitle("Call +44151496014 back", {})).toBe(
      "Call [redacted-phone] back",
    );
  });

  it("redacts a 12-digit E.164-shaped number as card-shaped (CC precedence)", () => {
    // CC runs before phone: a 12-digit run matches CC_LIKE first even when
    // the digits are phone-shaped. Privacy-safe over-classification, not a
    // leak — pinned so any change to the interaction is conscious.
    expect(redactWindowTitle("Call +441514960148 back", {})).toBe(
      "Call +[redacted-cc] back",
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
      "mail [redacted-email] and [redacted-email], call [redacted-phone] or [redacted-phone], card [redacted-cc]",
    );
  });

  it("treats digit-adjacent phone pairs as one CC-shaped run (over-redaction, not leakage)", () => {
    // Two 10-digit phones separated only by a space form a 20-digit run;
    // the CC pass redacts it whole before the phone pass runs. Pinned as
    // an exact string so any change to that shape is a conscious decision.
    expect(redactWindowTitle("4154960148 4154960149", {})).toBe(
      "[redacted-cc]",
    );
  });

  it("leaves no raw digits behind after redaction for PAN-dense titles", () => {
    const redacted = redactWindowTitle(
      "4111111111111111 and 4111111111111111",
      {},
    );
    expect(redacted).not.toMatch(/\d{4}/);
  });
});

describe("redactWindowTitle: resolver seam", () => {
  // Pins that resolveRedactorConfigFromEnv()'s return value is accepted by
  // redactWindowTitle — the two halves of the seam the reporting layer
  // joins (activity-tracker-reporting.ts:163). Not an integration test of
  // getActivityReportBetween (that path needs a DB-backed runtime).
  it("accepts the config resolved from the environment", () => {
    const redactor = resolveRedactorConfigFromEnv();
    expect(redactWindowTitle("Card 4111 1111 1111 1111 - Bank", redactor)).toBe(
      "Card [redacted-cc] - Bank",
    );
  });
});
