import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("trajectory logger trunc",()=>{
  const src=fs.readFileSync("plugins/plugin-trajectory-logger/src/components/TrajectoryLoggerSpatialView.tsx","utf8");
  it("reserve -3",()=>expect(src).toContain("slice(0, max - 3)}..."));
  it("no bare",()=>expect(src.includes("slice(0, max)}...")).toBe(false));
  it("payload + sibling",()=>{
    const max=160; expect(max+3).toBe(163); expect((max-3)+3).toBe(160);
    const sib=fs.readFileSync("packages/agent/src/api/health-routes.ts","utf8");
    expect(sib).toContain("maxStringLength - 3");
  });
  it("count 1",()=>expect((src.match(/max - 3/g)||[]).length).toBeGreaterThanOrEqual(1));
});
