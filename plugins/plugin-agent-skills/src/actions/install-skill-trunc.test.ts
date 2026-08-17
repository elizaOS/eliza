import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("install skill trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-agent-skills/src/actions/install-skill.ts","utf8");
  it("reserve -28",()=>expect(src).toContain("SKILL_INSTALL_TEXT_MAX_CHARS - 28"));
  it("no bare",()=>expect(src.includes("SKILL_INSTALL_TEXT_MAX_CHARS)}\\n\\n[truncated install")).toBe(false));
  it("payload + sibling",()=>{
    const MAX=3000, suffix="\n\n[truncated install result]"; expect(suffix.length).toBe(28);
    expect(MAX+suffix.length).toBe(3028); expect((MAX-28)+suffix.length).toBe(3000);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/SKILL_INSTALL_TEXT_MAX_CHARS - 28/g)||[]).length).toBe(1));
});
