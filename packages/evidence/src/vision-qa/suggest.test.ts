/**
 * suggestQuestions tests over three synthetic analysis fixtures — a clean
 * screenshot (no anomalies → no questions), a brand/diff-anomaly screenshot
 * (blue over threshold + large diff region → targeted questions), and an
 * OCR/expectation screenshot (dev strings + missing/forbidden copy). Asserts
 * determinism (same in → same out) and the stable id scheme the certify
 * reviewer keys off.
 */

import { describe, expect, it } from "vitest";
import type { AnalysisInput } from "./suggest.ts";
import { suggestQuestions } from "./suggest.ts";

const CLEAN: AnalysisInput = {
  ocr_text: "Welcome back\nSend a message",
  color_fractions: { blue_fraction: 0.005 },
  change_vs_baseline: { changed_fraction: 0.01, changed_bbox_norm: null },
};

const ANOMALOUS: AnalysisInput = {
  ocr_text: "Dashboard",
  color_fractions: { blue_fraction: 0.14 },
  change_vs_baseline: {
    changed_fraction: 0.32,
    changed_bbox_norm: [0.1, 0.2, 0.5, 0.6],
  },
};

const OCR_DIRTY: AnalysisInput = {
  ocr_text: "Lorem ipsum dolor\nTODO wire this up\nSend",
  color_fractions: { blue_fraction: 0.0 },
};

describe("suggestQuestions", () => {
  it("returns no questions for a clean analysis", () => {
    expect(suggestQuestions(CLEAN)).toEqual([]);
  });

  it("asks about blue and the diff region on an anomalous analysis", () => {
    const questions = suggestQuestions(ANOMALOUS, {
      viewName: "Dashboard view",
    });
    const ids = questions.map((q) => q.id);
    expect(ids).toContain("q-blue");
    expect(ids).toContain("q-diff");
    const blue = questions.find((q) => q.id === "q-blue");
    expect(blue?.expected).toBe("no");
    expect(blue?.question).toContain("14.0%");
    const diff = questions.find((q) => q.id === "q-diff");
    expect(diff?.question).toContain("Dashboard view");
    expect(diff?.question).toContain("(0.10, 0.20)");
  });

  it("asks about each dev/placeholder string found in OCR", () => {
    const questions = suggestQuestions(OCR_DIRTY);
    const devQuestions = questions.filter((q) => q.id.startsWith("q-dev-"));
    expect(devQuestions.length).toBe(2); // "Lorem ipsum" and "TODO"
    expect(devQuestions.every((q) => q.expected === "no")).toBe(true);
    expect(devQuestions[0].question).toContain("Lorem ipsum");
  });

  it("asks about missing required copy and forbidden present copy", () => {
    const questions = suggestQuestions(
      { ocr_text: "Loading spinner\nError: 500" },
      {
        viewName: "Chat view",
        expectations: {
          requireText: ["Send a message"],
          forbidText: ["Error: 500"],
        },
      },
    );
    const ids = questions.map((q) => q.id);
    expect(ids).toContain("q-missing-0");
    expect(ids).toContain("q-forbidden-0");
    expect(questions.find((q) => q.id === "q-missing-0")?.expected).toBe("yes");
    expect(questions.find((q) => q.id === "q-forbidden-0")?.expected).toBe(
      "no",
    );
  });

  it("is deterministic — identical input yields identical output", () => {
    expect(suggestQuestions(ANOMALOUS)).toEqual(suggestQuestions(ANOMALOUS));
  });

  it("accepts camelCase analysis fields too", () => {
    const questions = suggestQuestions({
      ocrText: "x",
      colorFractions: { blueFraction: 0.2 },
      changeVsBaseline: {
        changedFraction: 0.4,
        changedBboxNorm: [0, 0, 1, 1],
      },
    });
    expect(questions.map((q) => q.id)).toEqual(["q-blue", "q-diff"]);
  });
});
