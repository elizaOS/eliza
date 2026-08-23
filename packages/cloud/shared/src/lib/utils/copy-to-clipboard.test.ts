/**
 * Coverage for copy-to-clipboard.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { copyTextToClipboard } from "./copy-to-clipboard.js";
describe("copy-to-clipboard", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("returns boolean", async () => {
    const result = await copyTextToClipboard("hello");
    expect(typeof result).toBe("boolean");
  });
  it("handles empty", async () => {
    expect(typeof await copyTextToClipboard("")).toBe("boolean");
  });
});
