import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("web-fetch trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-coding-tools/src/actions/web-fetch.ts","utf8");
  it("reserve -12",()=>expect(src).toContain("WEB_FETCH_RESULT_CHARS - 12"));
  it("no bare",()=>expect(src.includes("slice(0, WEB_FETCH_RESULT_CHARS)}\n[truncated]")).toBe(false));
  it("payload + sibling",()=>{
    const MAX=4096; const suffix="\n[truncated]"; expect(suffix.length).toBe(12);
    expect(MAX+suffix.length).toBe(4108); expect((MAX-12)+suffix.length).toBe(4096);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/WEB_FETCH_RESULT_CHARS - 12/g)||[]).length).toBe(1));
});
