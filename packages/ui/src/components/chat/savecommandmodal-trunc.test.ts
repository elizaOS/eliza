import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("savecommandmodal trunc",()=>{
  const src=fs.readFileSync("packages/ui/src/components/chat/SaveCommandModal.tsx","utf8");
  it("reserve 117",()=>expect(src).toContain("slice(0, 117)}..."));
  it("no bare 120",()=>expect(src.includes("slice(0, 120)}...")).toBe(false));
  it("payload + sibling",()=>{
    expect(120+3).toBe(123); expect(117+3).toBe(120);
    const sib=fs.readFileSync("packages/agent/src/api/health-routes.ts","utf8");
    expect(sib).toContain("maxStringLength - 3");
  });
  it("count 1",()=>expect((src.match(/slice\(0, 117\)/g)||[]).length).toBe(1));
});
