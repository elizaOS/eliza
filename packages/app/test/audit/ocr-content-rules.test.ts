/**
 * Unit tests for the pixel-truth OCR content rules. Pure functions over
 * hand-authored OCR fixtures — no OCR engine, no screenshots — so every verdict
 * branch (blank, dev-string leak, placeholder, missing/forbidden expectation,
 * positive verify) is exercised deterministically.
 */
import { describe, expect, it } from "vitest";
import {
  detectErrorLeaks,
  detectPlaceholderLeaks,
  evaluateOcrContent,
  normalize,
  type OcrResult,
} from "../ui-smoke/ocr-content-rules";

function ocr(text: string, over: Partial<OcrResult> = {}): OcrResult {
  const lines = text.split("\n").filter(Boolean);
  return {
    ok: true,
    text,
    lines,
    words: text.split(/\s+/).filter(Boolean).length,
    meanConfidence: 1,
    ...over,
  };
}

describe("detectErrorLeaks", () => {
  it("flags machine residue a user should never see", () => {
    expect(detectErrorLeaks("Hi [object Object] there")).toContain(
      "[object Object]",
    );
    expect(detectErrorLeaks("value: undefined")).toContain("undefined");
    expect(detectErrorLeaks("TypeError: x")).toContain("TypeError");
    expect(detectErrorLeaks("Cannot read properties of null")).not.toHaveLength(
      0,
    );
  });
  it("does NOT flag a designed error state's copy", () => {
    expect(detectErrorLeaks("Something went wrong. Retry?")).toHaveLength(0);
    expect(detectErrorLeaks("Failed to send — tap to retry")).toHaveLength(0);
  });
});

describe("detectPlaceholderLeaks", () => {
  it("flags scaffolding text", () => {
    expect(detectPlaceholderLeaks("Lorem ipsum dolor")).not.toHaveLength(0);
    expect(detectPlaceholderLeaks("TODO wire this up")).toContain("TODO");
    expect(detectPlaceholderLeaks("Hello {{name}}")).not.toHaveLength(0);
  });
});

describe("normalize", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalize("  Ask   Eliza\n\n")).toBe("ask eliza");
  });
});

describe("evaluateOcrContent", () => {
  it("marks a failed decode broken, never empty", () => {
    const f = evaluateOcrContent({ ocr: ocr("", { ok: false, words: 0 }) });
    expect(f.verdict).toBe("broken");
    expect(f.reasons[0]).toMatch(/decode/);
  });

  it("marks an OCR engine failure broken with the real reason", () => {
    const f = evaluateOcrContent({
      ocr: ocr("", {
        ok: false,
        words: 0,
        reason: "tesseract.js worker initialization timed out",
      }),
    });
    expect(f.verdict).toBe("broken");
    expect(f.reasons[0]).toMatch(/tesseract\.js/);
  });

  it("catches a blank paint on a non-exempt view (the DOM-metric blind spot)", () => {
    const f = evaluateOcrContent({ ocr: ocr("+", { words: 1 }) });
    expect(f.blankPixels).toBe(true);
    expect(f.verdict).toBe("broken");
  });

  it("exempts TUI/canvas surfaces from the blank floor", () => {
    const f = evaluateOcrContent({
      ocr: ocr("", { words: 0 }),
      exemptFromBlank: true,
    });
    expect(f.blankPixels).toBe(false);
    expect(f.verdict).not.toBe("broken");
  });

  it("catches a developer string that reached the pixels", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Balance: [object Object]\nSend\nReceive"),
    });
    expect(f.errorLeaks).toContain("[object Object]");
    expect(f.verdict).toBe("broken");
  });

  it("verifies a view whose pixels contain every required label", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Good evening\nWeather\nAsk Eliza"),
      expectation: {
        requireAll: ["Ask Eliza"],
        requireAny: ["Good evening", "Good morning"],
      },
    });
    expect(f.verdict).toBe("verified");
    expect(f.missingRequired).toHaveLength(0);
  });

  it("breaks a view missing a label it exists to show", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Good evening\nWeather"),
      expectation: { requireAll: ["Ask Eliza"] },
    });
    expect(f.missingRequired).toContain("Ask Eliza");
    expect(f.verdict).toBe("broken");
  });

  it("reports a requireAny disjunction as one legible miss", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Some unrelated text here"),
      expectation: { requireAny: ["Good evening", "Good morning"] },
    });
    expect(f.missingRequired).toEqual(["Good evening | Good morning"]);
    expect(f.verdict).toBe("broken");
  });

  it("soft-flags scaffolding and forbidden leaks as needs-eyeball", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Welcome\nLorem ipsum dolor sit"),
      expectation: { requireAll: ["Welcome"], forbid: ["debug"] },
    });
    expect(f.placeholderLeaks).not.toHaveLength(0);
    expect(f.verdict).toBe("needs-eyeball");
  });

  it("keeps healthy-but-unexpectationed pixels as a soft signal, not a green claim", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Some readable content on screen"),
    });
    expect(f.verdict).toBe("needs-eyeball");
    expect(f.reasons.join(" ")).toMatch(/no expectation/);
  });
});
