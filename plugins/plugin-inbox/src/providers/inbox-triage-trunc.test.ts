import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("inbox triage trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-inbox/src/providers/inbox-triage.ts","utf8");
  it("reserve 57",()=>expect(src).toContain("slice(0, 57)}..."));
  it("no bare 60",()=>expect(src.includes('slice(0, 60)}..."')).toBe(false));
  it("payload + sibling",()=>{
    expect(60+3).toBe(63); expect(57+3).toBe(60);
    const sib=fs.readFileSync("packages/agent/src/api/health-routes.ts","utf8");
    expect(sib).toContain("maxStringLength - 3");
  });
  it("count 1",()=>expect((src.match(/slice\(0, 57\)/g)||[]).length).toBe(1));
});
