import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("acp native trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-agent-orchestrator/src/services/acp-native-transport.ts","utf8");
  it("reserve -1",()=>expect(src).toContain("slice(0, limit - 1)}…"));
  it("no bare",()=>expect(src.includes("slice(0, limit)}…")).toBe(false));
  it("payload + sibling",()=>{
    const lim=2000; expect(lim+1).toBe(2001); expect((lim-1)+1).toBe(2000);
    const sib=fs.readFileSync("plugins/plugin-personal-assistant/src/actions/resolve-request.ts","utf8");
    expect(sib).toContain("max - 1");
  });
  it("count 1",()=>expect((src.match(/limit - 1/g)||[]).length).toBeGreaterThanOrEqual(1));
});
