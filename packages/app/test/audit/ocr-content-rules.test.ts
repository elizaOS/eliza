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
import {
  resolveViewOcrPolicy,
  type SemanticOcrExpectationPolicy,
} from "../ui-smoke/ocr-view-expectations";

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

function expectationFor(
  slug: string,
): SemanticOcrExpectationPolicy["expectation"] {
  const policy = resolveViewOcrPolicy(slug);
  if (policy.kind !== "expectation") {
    throw new Error(`${slug} is not an expectation policy`);
  }
  return policy.expectation;
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
  it("lowercases and canonicalizes punctuation and whitespace", () => {
    expect(normalize("  Ask   Eliza\n\n")).toBe("ask eliza");
    expect(normalize("Fine-Tuning")).toBe("fine tuning");
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
    const f = evaluateOcrContent({
      ocr: ocr("+", {
        words: 1,
        pixelBlank: true,
        pixelBlankReasons: ["screenshot is one color"],
      }),
    });
    expect(f.blankPixels).toBe(true);
    expect(f.ocrInconclusive).toBe(false);
    expect(f.verdict).toBe("broken");
    expect(f.reasons).toContain("pixels are blank — screenshot is one color");
  });

  it("keeps an unreadable nonblank frame distinct from a proven blank render", () => {
    const f = evaluateOcrContent({
      ocr: ocr("oY)", {
        words: 1,
        meanConfidence: 0.4,
        pixelBlank: false,
      }),
    });
    expect(f.blankPixels).toBe(false);
    expect(f.ocrInconclusive).toBe(true);
    expect(f.verdict).toBe("needs-eyeball");
    expect(f.reasons.join(" ")).toMatch(/OCR inconclusive.*not blank/);
  });

  it("does not fabricate a missing-label defect from low-confidence OCR", () => {
    const f = evaluateOcrContent({
      ocr: ocr("glyph noise", {
        meanConfidence: 0.2,
        pixelBlank: false,
      }),
      expectation: { requireAll: ["Ask Eliza"] },
    });
    expect(f.missingRequired).toHaveLength(0);
    expect(f.verdict).toBe("needs-eyeball");
  });

  it.each([
    [
      "builtin-inventory",
      `< Wallet
$1,650.50 OO0C0 . ac
B laa
OOOO em onzs..5678 [©
© sot som.mz ©
EE ——
© EH osOL USDC
(A eee W——
[+ as Able)
-`,
      0.43,
    ],
    [
      "plugin-wallet-gui",
      `8 $1,650.50 CCO00 we
oem esol
CO00 ew oazs.ser8 © Oso som.mz ©
CE —
oem esol usc
£2 Tokens < DeFi (3 NFTs
$900.00
ETH
0250000 en a
- Tea
[4 Ask ape)
ph eg`,
      0.39,
    ],
  ])(
    "verifies %s when declared anchors survive globally noisy OCR",
    (slug, text, meanConfidence) => {
      const f = evaluateOcrContent({
        ocr: ocr(text, { meanConfidence, pixelBlank: false }),
        expectation: expectationFor(slug),
      });
      expect(f.ocrInconclusive).toBe(false);
      expect(f.missingRequired).toHaveLength(0);
      expect(f.verdict).toBe("verified");
    },
  );

  it("keeps the word floor even when a one-word semantic anchor matches", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Tasks", {
        words: 1,
        meanConfidence: 0.99,
        pixelBlank: false,
      }),
      expectation: { requireAll: ["Tasks"] },
    });
    expect(f.ocrInconclusive).toBe(true);
    expect(f.verdict).toBe("needs-eyeball");
  });

  it("exempts TUI/canvas surfaces from the blank floor", () => {
    const f = evaluateOcrContent({
      ocr: ocr("", { words: 0 }),
      exemptFromBlank: true,
    });
    expect(f.blankPixels).toBe(false);
    expect(f.verdict).not.toBe("broken");
  });

  it("keeps a matched semantic exemption visible without calling it verified", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Settings Wallet Projects"),
      expectation: {
        requireAll: ["Settings", "Wallet"],
        requireAny: ["Projects", "Calendar"],
      },
      semanticExemptionReason: "native-only surface",
    });
    expect(f.verdict).toBe("needs-eyeball");
    expect(f.reasons).toContain("semantic OCR exemption — native-only surface");
  });

  it("still breaks an exempt surface when its observable fallback drifts", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Unrelated readable fallback"),
      expectation: { requireAll: ["Settings", "Wallet"] },
      semanticExemptionReason: "native-only surface",
    });
    expect(f.verdict).toBe("broken");
    expect(f.missingRequired).toEqual(["Settings", "Wallet"]);
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

  it("tolerates OCR punctuation and word-join segmentation without fuzzy spelling", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Fine Tuning\nNewnote"),
      expectation: { requireAll: ["Fine-Tuning", "New note"] },
    });
    expect(f.verdict).toBe("verified");
    expect(f.missingRequired).toHaveLength(0);

    const misspelled = evaluateOcrContent({
      ocr: ocr("Fine Tunning\nNew not"),
      expectation: { requireAll: ["Fine-Tuning", "New note"] },
    });
    expect(misspelled.verdict).toBe("broken");
    expect(misspelled.missingRequired).toEqual(["Fine-Tuning", "New note"]);
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
      "Name\nEliza\nSystem prompt\nYou are Eliza, a concise assistant for UI smoke tests",
    ],
    [
      "builtin-database",
      "< Databases\nTables Media Vectors\nTable\nee SQL Editor\n® pglite\n= —_—\nFilter\ntabl\nar [A",
    ],
    [
      "builtin-logs",
      "< Logs\nAll levels\nAll sources\nAll tags\nINFO\nsmoke\nsmoke API ready",
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
      expectation: expectationFor(slug),
    });
    expect(f.verdict).toBe("verified");
    expect(f.missingRequired).toHaveLength(0);
  });

  it.each([
    [
      "builtin-browser",
      "< Browser\n@Notab © + OX EnteralRL Go\nAgent Browser Bridge\n+ Ask",
    ],
    [
      "plugin-notes-gui",
      "Launch checklist Followup\nCloud agent, phone, and deck are ready.\nShare the demo recording with the team.",
    ],
  ])("verifies current macOS OCR segmentation for %s", (slug, text) => {
    const f = evaluateOcrContent({
      ocr: ocr(text),
      expectation: expectationFor(slug),
    });
    expect(f.verdict).toBe("verified");
    expect(f.missingRequired).toHaveLength(0);
  });

  it("verifies the deterministic chat home semantics", () => {
    const f = evaluateOcrContent({
      ocr: ocr("Mostly clear\nToday\nLearn conversational Spanish"),
      expectation: expectationFor("builtin-chat"),
    });
    expect(f.verdict).toBe("verified");
  });
});
