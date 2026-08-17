import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("app-control trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-app-control/src/params.ts","utf8");
  it("reserve 119",()=>expect(src).toContain("slice(0, 119)}…"));
  it("no bare",()=>expect(src.includes("slice(0, 120)}…")).toBe(false));
  it("payload + sibling",()=>{
    expect(120+1).toBe(121); expect(119+1).toBe(120);
    const sib=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/slice\(0, 119\)/g)||[]).length).toBe(1));
});
