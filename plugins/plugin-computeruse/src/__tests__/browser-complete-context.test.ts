/**
 * Deterministic admission tests for complete computer-use browser context.
 * DOM and clickable inventories remain lossless regardless of content length.
 */
import { describe, expect, it } from "vitest";
import {
  admitCompleteBrowserClickables,
  admitCompleteBrowserDom,
} from "../platform/browser.js";

describe("computer-use browser complete-content admission", () => {
  it("preserves DOM content beyond the former 5,000-character prefix", () => {
    const tail = "complete-dom-tail";
    const html = `<main>${"x".repeat(20_000)}${tail}</main>`;
    expect(admitCompleteBrowserDom(html)).toBe(html);
    expect(admitCompleteBrowserDom(html)).toContain(tail);
  });

  it("preserves DOM content beyond the former replacement admission ceiling", () => {
    const html = `${"x".repeat(1_048_577)}complete-large-dom-tail`;
    expect(admitCompleteBrowserDom(html)).toBe(html);
    expect(admitCompleteBrowserDom(html)).toContain("complete-large-dom-tail");
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
