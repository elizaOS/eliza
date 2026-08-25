/**
 * Regression for complete, well-formed cloud MCP dynamic tool output.
 */

import { describe, expect, it } from "vitest";
import { normalizeMcpToolOutput } from "./dynamic-tool-actions";

function isWellFormed(v: string): boolean {
  if (!v) return true;
  if (typeof (v as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function")
    return (v as unknown as { isWellFormed: () => boolean }).isWellFormed();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = v.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("cloud MCP normalizeMcpToolOutput", () => {
  it("preserves complete output across the former 8000-character boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(7_999)}${fox}${"b".repeat(50)}`;
    const out = normalizeMcpToolOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(5000)}${fox}`;
    const out = normalizeMcpToolOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes a lone surrogate while preserving all remaining output", () => {
    const lone = `mcp ${String.fromCharCode(0xd800)} ${"a".repeat(10000)}`;
    const out = normalizeMcpToolOutput(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.endsWith("a".repeat(10_000))).toBe(true);
  });

  it("sanitizes lone surrogate without truncation when fitting", () => {
    const lone = `mcp ${String.fromCharCode(0xd800)} ok`;
    const out = normalizeMcpToolOutput(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("mcp \uFFFD ok");
  });
});
