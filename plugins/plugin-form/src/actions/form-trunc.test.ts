import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("form trunc reserve",()=>{
  it("reserve 35 for \\n\\n[truncated restored form summary]",()=>{
    const src=fs.readFileSync("plugins/plugin-form/src/actions/form.ts","utf8");
    expect(src).toContain("slice(0, RESTORE_RESPONSE_MAX_CHARS - 35)}");
  });
  it("no bare remains",()=>{
    const src=fs.readFileSync("plugins/plugin-form/src/actions/form.ts","utf8");
    expect(src).not.toContain("slice(0, RESTORE_RESPONSE_MAX_CHARS)}\\n\\n[truncated restored");
  });
  it("payload weak vs fixed sibling correct",()=>{
    const MAX=4000, suffix="\n\n[truncated restored form summary]";
    expect(suffix.length).toBe(35);
    expect(("a".repeat(4001).slice(0,MAX)+suffix).length).toBe(4035);
    expect(("a".repeat(4001).slice(0,MAX-35)+suffix).length).toBe(4000);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("slice(0, max - suffix.length)");
  });
  it("count 1",()=>{
    const src=fs.readFileSync("plugins/plugin-form/src/actions/form.ts","utf8");
    expect((src.match(/RESTORE_RESPONSE_MAX_CHARS - 35/g)||[]).length).toBe(1);
  });
});
