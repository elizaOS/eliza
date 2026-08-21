/**
 * Regression for cloud MCP dynamic tool output truncation surrogate safety (8000).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const MCP_TOOL_OUTPUT_MAX_CHARS = 8_000;

function truncateMcpToolOutput(output: string): string {
  const wellFormed = toWellFormedUnicode(output);
  if (wellFormed.length <= MCP_TOOL_OUTPUT_MAX_CHARS) return wellFormed;
  return `${truncateWellFormed(wellFormed, MCP_TOOL_OUTPUT_MAX_CHARS)}\n\n[truncated MCP tool output at ${MCP_TOOL_OUTPUT_MAX_CHARS} chars]`;
}

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

describe("cloud MCP truncateMcpToolOutput well-formed", () => {
  it("keeps surrogate pair intact at 8000-char boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(MCP_TOOL_OUTPUT_MAX_CHARS - 1)}${fox}${"b".repeat(50)}`;
    const out = truncateMcpToolOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("[truncated MCP tool output at 8000 chars]")).toBe(true);
    expect(out).not.toContain("\uD83E");
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(5000)}${fox}`;
    const out = truncateMcpToolOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes lone surrogate before truncation", () => {
    const lone = `mcp ${String.fromCharCode(0xd800)} ${"a".repeat(10000)}`;
    const out = truncateMcpToolOutput(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
  });

  it("sanitizes lone surrogate without truncation when fitting", () => {
    const lone = `mcp ${String.fromCharCode(0xd800)} ok`;
    const out = truncateMcpToolOutput(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("mcp \uFFFD ok");
  });
});
