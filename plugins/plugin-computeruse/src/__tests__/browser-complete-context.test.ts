/**
 * Deterministic admission tests for complete computer-use browser context.
 * Admitted DOM and clickable inventories remain lossless; oversized content
 * fails atomically instead of returning a prefix.
 */
import { describe, expect, it } from "vitest";
import {
  admitCompleteBrowserClickables,
  admitCompleteBrowserDom,
  MAX_BROWSER_CONTEXT_UTF8_BYTES,
} from "../platform/browser.js";

describe("computer-use browser complete-content admission", () => {
  it("preserves DOM content beyond the former 5,000-character prefix", () => {
    const tail = "complete-dom-tail";
    const html = `<main>${"x".repeat(20_000)}${tail}</main>`;
    expect(admitCompleteBrowserDom(html)).toBe(html);
    expect(admitCompleteBrowserDom(html)).toContain(tail);
  });

  it("rejects oversized DOM atomically", () => {
    const html = "x".repeat(MAX_BROWSER_CONTEXT_UTF8_BYTES + 1);
    expect(() => admitCompleteBrowserDom(html)).toThrow(
      /COMPUTER_USE_BROWSER_CONTENT_TOO_LARGE|complete-content admission ceiling/,
    );
  });

  it("preserves every clickable and complete labels", () => {
    const tail = "complete-clickable-tail";
    const elements = Array.from({ length: 75 }, (_, index) => ({
      tag: "button",
      selector: `#button-${index}`,
      text: `${"label".repeat(40)}-${index}${index === 74 ? tail : ""}`,
    }));
    const admitted = admitCompleteBrowserClickables(elements);
    expect(admitted).toBe(elements);
    expect(admitted).toHaveLength(75);
    expect(admitted.at(-1)?.text).toContain(tail);
  });
});
