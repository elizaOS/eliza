import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("meeting transcript trunc reserve",()=>{
  it("defines suffix and reserves suffix.length",()=>{
    const src=fs.readFileSync("plugins/plugin-meetings/src/actions/get-meeting-transcript.ts","utf8");
    expect(src).toContain("const suffix = `\\n… (truncated — open transcript ${transcript.id}");
    expect(src).toContain("slice(0, MAX_REPLY_CHARS - suffix.length)}${suffix}");
  });
  it("no bare slice(0, MAX_REPLY_CHARS) without reserve",()=>{
    const src=fs.readFileSync("plugins/plugin-meetings/src/actions/get-meeting-transcript.ts","utf8");
    expect(src).not.toContain("slice(0, MAX_REPLY_CHARS)}\\n… (truncated");
  });
  it("count 1 suffix definition",()=>{
    const src=fs.readFileSync("plugins/plugin-meetings/src/actions/get-meeting-transcript.ts","utf8");
    expect((src.match(/suffix\.length/g)||[]).length).toBeGreaterThanOrEqual(1);
  });
  it("payload weak vs fixed + sibling correct",()=>{
    const MAX=4000;
    const id="abc123";
    const suffix=`\n… (truncated — open transcript ${id} in the Transcripts view for the full record)`;
    expect(suffix.length).toBeGreaterThan(30);
    const text="a".repeat(4001);
    const weak=(text.slice(0,MAX)+suffix).length;
    const fixed=(text.slice(0,MAX - suffix.length)+suffix).length;
    expect(weak).toBe(4001 -1 + suffix.length); // 4001? Actually 4000+suffix vs 4001? For 4001 length > MAX, weak = 4000+suffix, fixed=MAX
    expect(fixed).toBe(4000);
    expect(weak).toBeGreaterThan(4000);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("slice(0, max - suffix.length)");
  });
});
