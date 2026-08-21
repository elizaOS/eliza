/**
 * Surrogate-safe truncation for hasIntent task (2k) and message (500) caps.
 *
 * Exercises the exported seams `extractTaskTextForIntent` /
 * `extractMessageTextForIntent` so restoring a naive `.slice(0, cap)` at either
 * site makes the suite red: the clamp would leave a lone surrogate and fail the
 * `isWellFormed` / length / `�` assertions.
 */

import { describe, expect, test } from "vitest";
import {
  extractMessageTextForIntent,
  extractTaskTextForIntent,
  hasIntent,
} from "./prompt-compaction.ts";

const FOX = "🦊";
const HIGH = String.fromCharCode(0xd800);
const LOW = String.fromCharCode(0xdc00);

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
}

describe("prompt-compaction intent detection surrogate safety", () => {
  test("extractTaskTextForIntent backs off astral at 2000: 1999+fox → 1999 well-formed", () => {
    const prompt = `<task>${"a".repeat(1999)}${FOX}${"b".repeat(100)} deploy</task>`;
    const out = extractTaskTextForIntent(prompt, 2000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(1999);
    expect(out.endsWith(FOX)).toBe(false);
    expect(() => JSON.stringify({ out })).not.toThrow();
    expect(JSON.stringify(out).includes("\\ud83e")).toBe(false);
  });

  test("extractTaskTextForIntent keeps fitting emoji exactly at 2000: 1998+fox → 2000", () => {
    const prompt = `<task>${"a".repeat(1998)}${FOX}</task>`;
    const out = extractTaskTextForIntent(prompt, 2000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(2000);
    expect(out.endsWith(FOX)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("extractMessageTextForIntent backs off astral at 500: 499+fox → 499 well-formed", () => {
    const prompt = `# Received Message\n${"a".repeat(499)}${FOX}${"b".repeat(100)}`;
    const out = extractMessageTextForIntent(prompt, 500);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(499);
    expect(out.endsWith(FOX)).toBe(false);
    expect(() => JSON.stringify({ out })).not.toThrow();
    expect(JSON.stringify(out).includes("\\ud83e")).toBe(false);
  });

  test("extractMessageTextForIntent keeps fitting emoji exactly at 500: 498+fox → 500", () => {
    // Use no leading newline after the header so the trimmed content can be
    // exactly 500 code units (498 a + fox). With the realistic "\n" prefix the
    // raw cap includes the newline and the trimmed length would be 499; the
    // seam still guarantees isWellFormed in either shape.
    const prompt = `# Received Message${"a".repeat(498)}${FOX}`;
    const out = extractMessageTextForIntent(prompt, 500);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(500);
    expect(out.endsWith(FOX)).toBe(true);
  });

  test("extractTaskTextForIntent sanitizes lone high surrogate to replacement", () => {
    const prompt = `<task>hi ${HIGH} there deploy</task>`;
    const out = extractTaskTextForIntent(prompt, 2000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(HIGH)).toBe(false);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("extractMessageTextForIntent sanitizes lone low surrogate to replacement", () => {
    const prompt = `# Received Message\nok ${LOW} there`;
    const out = extractMessageTextForIntent(prompt, 500);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(LOW)).toBe(false);
  });

  test("hasIntent still matches keyword after well-formed clamp via production path", () => {
    // Keyword "deploy" is inside the first 2000 chars; a fox at offset 1999 must not hide it.
    const prompt = `<task>${"a".repeat(100)} deploy ${"b".repeat(10)}</task>`;
    expect(hasIntent(prompt, /deploy/i)).toBe(true);
    const foxPrompt = `<task>${"a".repeat(1999)}${FOX}${"b".repeat(500)} deploy</task>`;
    // deploy is beyond the 2000 cap, so it should NOT match regardless of surrogate handling
    expect(hasIntent(foxPrompt, /deploy/i)).toBe(false);
  });

  test("hasIntent via production path never leaves lone surrogate in task/message (sweep)", () => {
    for (let offset = -5; offset <= 5; offset++) {
      const nTask = 1995 + offset;
      const taskPrompt = `<task>${"a".repeat(nTask)}${FOX}${"b".repeat(100)} action</task>`;
      const tOut = extractTaskTextForIntent(taskPrompt, 2000);
      expect(isWellFormed(tOut)).toBe(true);
      expect(tOut.length).toBeLessThanOrEqual(2000);
      expect(() => JSON.stringify(tOut)).not.toThrow();

      const nMsg = 495 + offset;
      const msgPrompt = `# Received Message\n${"a".repeat(nMsg)}${FOX}${"b".repeat(100)}`;
      const mOut = extractMessageTextForIntent(msgPrompt, 500);
      expect(isWellFormed(mOut)).toBe(true);
      expect(mOut.length).toBeLessThanOrEqual(500);
      expect(() => JSON.stringify(mOut)).not.toThrow();

      // also drive the composed hasIntent path so a future regression that
      // refactors the seams bypassing hasIntent still shows as in-well-formed
      expect(() => hasIntent(taskPrompt, /action/i)).not.toThrow();
      expect(() => hasIntent(msgPrompt, /execute/i)).not.toThrow();
      expect(isWellFormed(tOut)).toBe(true);
    }
  });

  test("hasIntent message path respects delimiter: keyword before delimiter is in-text, after is dropped", () => {
    const prompt = `# Received Message\n${"a".repeat(10)} deploy here\n# Next Section\n deploy again`;
    // The first userMsg slice ends before "\n#", so deploy there should match
    expect(hasIntent(prompt, /deploy/i)).toBe(true);
    // Prompt with no delimiter: clamp at 500 must still be well-formed
    const noDelim = `# Received Message\n${"a".repeat(499)}${FOX}${"b".repeat(100)} deploy`;
    const out = extractMessageTextForIntent(noDelim, 500);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(499);
  });
});
