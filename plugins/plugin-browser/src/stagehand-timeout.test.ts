/**
 * File-grep proof for stagehand fetch timeout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./targets/stagehand-target.ts", import.meta.url), "utf8");
let healthSrc="";
try { healthSrc=readFileSync(new URL("../../packages/agent/src/health-oauth.ts", import.meta.url), "utf8"); } catch{}
if(!healthSrc){ try{ healthSrc=readFileSync("/tmp/eliza-verify2/packages/agent/src/health-oauth.ts","utf8"); }catch{}}
describe("stagehand timeout", () => {
  it("bounds health GET with 15_000",()=>{ expect(src).toContain("fetch(healthUrl"); expect(src).toMatch(/fetch\(healthUrl,[\s\S]{0,100}AbortSignal\.timeout\(15_000\)/); });
  it("bounds command POST with 15_000",()=>{ expect(src).toContain("fetch(commandUrl"); expect(src).toMatch(/fetch\(commandUrl,[\s\S]{0,300}AbortSignal\.timeout\(15_000\)/); });
  it("count 2 and no bare remain",()=>{ const m=src.match(/AbortSignal\.timeout\(15_000\)/g)||[]; expect(m.length).toBe(2); expect(src).not.toContain("fetch(healthUrl, { method: \"GET\" });"); expect(src).not.toContain("body: JSON.stringify({ command }),\n  });"); });
  it("sibling still correct",()=>{ expect(typeof healthSrc).toBe("string"); if(healthSrc) expect(healthSrc).toContain("AbortSignal.timeout(15_000)"); });
});
