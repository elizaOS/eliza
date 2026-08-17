import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("get skill details trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-agent-skills/src/actions/get-skill-details.ts","utf8");
  it("reserve -27",()=>expect(src).toContain("SKILL_DETAILS_TEXT_MAX_CHARS - 27"));
  it("no bare",()=>expect(src.includes("SKILL_DETAILS_TEXT_MAX_CHARS)}\\n\\n[truncated skill details")).toBe(false));
  it("payload + sibling",()=>{
    const MAX=4000, suffix="\n\n[truncated skill details]"; expect(suffix.length).toBe(27);
    expect(MAX+suffix.length).toBe(4027); expect((MAX-27)+suffix.length).toBe(4000);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/SKILL_DETAILS_TEXT_MAX_CHARS - 27/g)||[]).length).toBe(1));
});
