import { describe, it, expect } from "vitest";
import fs from "node:fs";
describe("browser-workspace trunc", () => {
  it("reserve MAX_EVENT_STRING_LENGTH -3 for ...", () => {
    const src=fs.readFileSync("packages/app-core/platforms/electrobun/src/native/browser-workspace.ts","utf8");
    expect(src).toContain("slice(0, MAX_EVENT_STRING_LENGTH - 3)}...");
  });
  it("no bare slice without reserve", ()=>{
    const src=fs.readFileSync("packages/app-core/platforms/electrobun/src/native/browser-workspace.ts","utf8");
    expect(src).not.toContain("slice(0, MAX_EVENT_STRING_LENGTH)}...");
  });
  it("count 1 reserved", ()=>{
    const src=fs.readFileSync("packages/app-core/platforms/electrobun/src/native/browser-workspace.ts","utf8");
    expect((src.match(/MAX_EVENT_STRING_LENGTH - 3/g)||[]).length).toBe(1);
  });
  it("payload weak 53 vs fixed 50 sibling correct", ()=>{
    const MAX=50;
    expect(("a".repeat(51).slice(0,MAX)+"...").length).toBe(53);
    expect(("a".repeat(51).slice(0,MAX-3)+"...").length).toBe(50);
    const sibling=fs.readFileSync("packages/agent/src/api/health-routes.ts","utf8");
    expect(sibling).toContain("slice(0, options.maxStringLength - 3)}...");
  });
});
