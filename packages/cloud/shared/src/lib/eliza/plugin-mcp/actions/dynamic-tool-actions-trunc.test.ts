import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("mcp trunc reserve",()=>{
  it("defines suffix and reserves suffix.length",()=>{
    const src=fs.readFileSync("packages/cloud/shared/src/lib/eliza/plugin-mcp/actions/dynamic-tool-actions.ts","utf8");
    expect(src).toContain("const suffix = `\\n\\n[truncated MCP tool output at ${MCP_TOOL_OUTPUT_MAX_CHARS} chars]`");
    expect(src).toContain("slice(0, MCP_TOOL_OUTPUT_MAX_CHARS - suffix.length)}${suffix}");
  });
  it("no bare remains",()=>{
    const src=fs.readFileSync("packages/cloud/shared/src/lib/eliza/plugin-mcp/actions/dynamic-tool-actions.ts","utf8");
    expect(src).not.toContain("slice(0, MCP_TOOL_OUTPUT_MAX_CHARS)}\\n\\n[truncated");
  });
  it("suffix length correct",()=>{
    const suffix=`\n\n[truncated MCP tool output at ${8000} chars]`;
    expect(suffix.length).toBeGreaterThan(30);
    const MAX=8000;
    expect(("a".repeat(8001).slice(0,MAX)+suffix).length).toBeGreaterThan(MAX);
    expect(("a".repeat(8001).slice(0,MAX - suffix.length)+suffix).length).toBe(MAX);
  });
  it("sibling correct workspace-provider",()=>{
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("slice(0, max - suffix.length)");
  });
});
