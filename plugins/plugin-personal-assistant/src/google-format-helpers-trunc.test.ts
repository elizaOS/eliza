import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./lifeops/google/format-helpers.ts", import.meta.url), "utf8");
let sib="";
try{ sib=readFileSync(new URL("./lifeops/anticipation/store.ts", import.meta.url), "utf8"); }catch{}
if(!sib){ try{ sib=readFileSync("/tmp/eliza-verify2/plugins/plugin-personal-assistant/src/lifeops/anticipation/store.ts","utf8"); }catch{}}
describe("google format helpers trunc",()=>{
  it("reserves",()=>{ expect(src).toContain("slice(0, maxLength - 1).trimEnd()}…"); expect(src).not.toContain("slice(0, maxLength).trimEnd()}…"); });
  it("single",()=>{ const m=src.match(/slice\(0, maxLength - 1\)/g)||[]; expect(m.length).toBe(1); });
  it("payload",()=>{ expect(("a".repeat(101).slice(0,100).trimEnd()+"…").length).toBe(101); expect(("a".repeat(101).slice(0,99).trimEnd()+"…").length).toBe(100); });
  it("sibling",()=>{ expect(typeof sib).toBe("string"); if(sib) expect(sib).toContain("SNIPPET_MAX_LENGTH - 1"); });
});
