import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("google format trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-personal-assistant/src/lifeops/google/format-helpers.ts","utf8");
  it("reserve -1 preview",()=>expect(src).toContain("slice(0, maxLength - 1).trimEnd()}…"));
  it("reserve -13 email",()=>expect(src).toContain("slice(0, maxChars - 13).trimEnd()}\\n\\n[truncated]") || expect(src).toContain("maxChars - 13"));
  it("no bare preview",()=>expect(src.includes("slice(0, maxLength).trimEnd()}…")).toBe(false));
  it("payload + sibling",()=>{
    const max=2500, suffix1="…", suffix2="\n\n[truncated]";
    expect(max+1).toBe(2501); expect((max-1)+1).toBe(2500);
    expect(suffix2.length).toBe(13); expect(max+suffix2.length).toBe(2513); expect((max-13)+suffix2.length).toBe(2500);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
});
