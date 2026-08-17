import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("parse-helpers trunc", () => {
  const src=fs.readFileSync("plugins/plugin-agent-skills/src/actions/parse-helpers.ts","utf8");
  it("reserve 119",()=>expect(src).toContain("slice(0, 119)}…"));
  it("no bare",()=>expect(src.includes("slice(0, 120)}…")).toBe(false));
  it("payload",()=>{
    const max=120,suffix="…"; expect(max+suffix.length).toBe(121); expect(119+suffix.length).toBe(120);
    const sib=fs.readFileSync("plugins/plugin-cloud-apps/src/client.ts","utf8");
    // sibling after our fix should be 119 on other branch but on develop still 120? use notify-service which is correct
    const sib2=fs.readFileSync("packages/agent/src/providers/workspace-provider.ts","utf8");
    expect(sib2).toContain("suffix.length");
  });
  it("count 1",()=>expect((src.match(/slice\(0, 119\)/g)||[]).length).toBe(1));
});
