/**
 * Verifies workspace-provider routing and its hard per-file character bound.
 * The deterministic tests exercise the exported provider helpers directly.
 */
import { describe, expect, it } from "vitest";
import { createWorkspaceProvider, truncate } from "./workspace-provider.ts";

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe("workspace provider routing", () => {
  it("only enters planner contexts that can act on the workspace", () => {
    const provider = createWorkspaceProvider();

    expect(provider.contexts).toEqual([
      "code",
      "files",
      "terminal",
      "automation",
    ]);
    expect(provider.contextGate).toEqual({
      anyOf: ["code", "files", "terminal", "automation"],
    });
  });
});

describe("workspace provider truncation", () => {
  it("reserves room for the suffix within the requested maximum", () => {
    const result = truncate("x".repeat(20_001), 20_000);

    expect(result).toHaveLength(20_000);
    expect(result.endsWith("[... truncated at 20,000 chars]")).toBe(true);
  });

  it("returns content at the bound unchanged", () => {
    const content = "x".repeat(20_000);

    expect(truncate(content, 20_000)).toBe(content);
  });

  it("honors bounds shorter than the suffix", () => {
    expect(truncate("longer", 4)).toBe("\n\n[.");
    expect(truncate("longer", 0)).toBe("");
    expect(truncate("longer", -1)).toBe("");
  });

  it("keeps surrogate pairs intact at the truncation boundary", () => {
    const max = 20_000;
    const suffix = `\n\n[... truncated at ${max.toLocaleString()} chars]`;
    const budget = max - suffix.length;
    const text = `${"a".repeat(budget - 1)}🦊${"b".repeat(100)}`;
    const out = truncate(text, max);
    expect(out.length).toBeLessThanOrEqual(max);
    expect(out.length).toBeGreaterThanOrEqual(max - 1);
    expect(out.isWellFormed()).toBe(true);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith(suffix)).toBe(true);
    expect(out.startsWith("a".repeat(budget - 1))).toBe(true);
    expect(out).not.toContain("🦊");
  });

  it("preserves a fitting emoji under the truncation cap", () => {
    const max = 100;
    const suffix = `\n\n[... truncated at ${max.toLocaleString()} chars]`;
    const budget = max - suffix.length;
    const text = `${"a".repeat(budget - 2)}🦊`;
    const out = truncate(text, max);
    expect(out).toBe(text);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone surrogates before truncation", () => {
    const lone = `a\uD800${"b".repeat(30_000)}`;
    const out = truncate(lone, 20_000);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
  });

  it("sanitizes lone surrogates without truncation when under limit", () => {
    const lone = `ok \uD800 end`;
    const out = truncate(lone, 100);
    expect(out).toBe(`ok � end`);
    expect(isWellFormed(out)).toBe(true);
  });

  it("never emits lone surrogates at every boundary around the suffix", () => {
    const max = 50;
    for (let n = 0; n <= max + 5; n++) {
      const text = `x`.repeat(n) + `🦊`;
      const out = truncate(text, max);
      expect(isWellFormed(out)).toBe(true);
      expect(out.isWellFormed()).toBe(true);
      expect(out.length).toBeLessThanOrEqual(
        Math.max(n <= max ? n : max, out.length),
      );
    }
  });
});
