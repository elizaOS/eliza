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
import { VIEW_EXPECTATIONS } from "../ui-smoke/ocr-view-expectations";

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

  it.each([
    [
      "builtin-apps",
      "< My Apps\nInstall, create, and run your elizaOS apps.\nAsk\nEliza\n+ UR",
    ],
    [
      "builtin-automations",
      "< Automations\nTora active Passe Fane\n[4] [4] [4] [4]\nS Al ©Pompts % Wordlows [> Active © Inactive\nAsk\nA @ Eliza\nC LL ar [A\n8",
    ],
    [
      "builtin-character-select",
      "hs\nEliza\nrm\nYouare za, a concise assistant for Ul smoke fests\nAsk\nEliza\n+ oi",
    ],
    [
      "builtin-database",
      "< Databases\nTables Media Vectors\nTable\nee SQL Editor\n® pglite\n= —_—\nFilter\ntabl\nar [A",
    ],
    [
      "builtin-logs",
      "< Logs\n1\n\nAlllevels ~ Alsources v Altags v\n\n25723 AM\n\nro\nsear\nch\n\nong",
    ],
    [
      "builtin-relationships",
      "< Character\npersonality Relationships skills Experience\nv al v\nsear\nch\n+ PQ\nple.",
    ],
    [
      "builtin-skills",
      "< skills\nA) on (0)\norr (0)\n— —\nSear\nch\nsls. gap\nar Op",
    ],
    ["builtin-tasks", "< Tasks\nox\nI)\n\\_/ E————\nAsk\nEliza\nAr (2"],
    [
      "builtin-transcripts",
      "< Live meeting\nPaste a Meet, Teams, or Zoom link\not namo (option)\n(©)\n+ AskEiza [UR",
    ],
  ])("verifies current CI OCR text for %s", (slug, text) => {
    const f = evaluateOcrContent({
      ocr: ocr(text),
      expectation: VIEW_EXPECTATIONS[slug],
    });
    expect(f.verdict).toBe("verified");
    expect(f.missingRequired).toHaveLength(0);
  });

  it("does not use stale positive text expectations for sparse builtin chat", () => {
    expect(VIEW_EXPECTATIONS["builtin-chat"]).toBeUndefined();
  });

  // #15781: the Polymarket view once painted its caught `.ready` TypeError into
  // the market-detail render. The expectation positively verifies the healthy
  // chrome across every viewport's layout, and the universal developer-string
  // rules reject the crash residue. The three OCR strings below are the exact
  // packaged-Tesseract reads off the committed audit capture per layout.
  it.each([
    // Desktop/tablet market-detail: "< Markets" back control renders.
    [
      "detail (desktop/tablet)",
      "< Wallet\nWallet Perps Predictions\n<Markets\nWill the Ul smoke suite stay green?\nYes 87% No 13%",
    ],
    // Mobile compact detail: no back control, but the Vol/Liq/Last metric row does.
    [
      "compact detail (mobile)",
      "< Wallet\nWallet Perps Predictions\nWill the Ul smoke suite stay green?\nYes 87% No 13%\nVol $45.7K - Liq $12.3K - Last 87%",
    ],
    // List state: readiness chips + the "markets" label.
    ["list", "reads ready trading off\n2 markets\nmarkets\n01 Will BTC..."],
  ])("verifies a healthy Polymarket render — %s", (_layout, text) => {
    const f = evaluateOcrContent({
      ocr: ocr(text),
      expectation: VIEW_EXPECTATIONS["plugin-polymarket-gui"],
    });
    expect(f.verdict).toBe("verified");
    expect(f.missingRequired).toHaveLength(0);
  });

  it("breaks the Polymarket view when the `.ready` crash string reaches the pixels", () => {
    const f = evaluateOcrContent({
      ocr: ocr(
        "markets\nCannot read properties of undefined (reading 'ready')",
      ),
      expectation: VIEW_EXPECTATIONS["plugin-polymarket-gui"],
    });
    expect(f.errorLeaks).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/undefined/),
        expect.stringMatching(/Cannot read propert/i),
      ]),
    );
    expect(f.verdict).toBe("broken");
  });
});
