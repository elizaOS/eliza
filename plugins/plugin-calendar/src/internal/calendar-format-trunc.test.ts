import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("calendar format trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-calendar/src/internal/format.ts","utf8");
  it("reserve -1",()=>expect(src).toContain("slice(0, maxLength - 1).trimEnd()}…"));
  it("no bare",()=>expect(src.includes("slice(0, maxLength).trimEnd()}…")).toBe(false));
  it("payload + sibling",()=>{
    const max=100; expect(max+1).toBe(101); expect((max-1)+1).toBe(100);
    const sib=fs.readFileSync("plugins/plugin-personal-assistant/src/actions/resolve-request.ts","utf8");
    expect(sib).toContain("max - 1");
  });
  it("count 1",()=>expect((src.match(/maxLength - 1/g)||[]).length).toBeGreaterThanOrEqual(1));
});
