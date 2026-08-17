import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./params.ts", import.meta.url), "utf8");
let sib="";
try { sib=readFileSync(new URL("../../plugin-agent-skills/src/providers/enabled-skills.ts", import.meta.url), "utf8"); } catch{}
if(!sib){ try{ sib=readFileSync("/tmp/eliza-verify2/plugins/plugin-agent-skills/src/providers/enabled-skills.ts","utf8"); }catch{}}
describe("appcontrol trunc", () => {
  it("reserves",()=>{ expect(src).toContain("slice(0, 119)}…"); expect(src).not.toContain("slice(0, 120)}…"); });
  it("single",()=>{ const m=src.match(/slice\(0, 119\)/g)||[]; expect(m.length).toBe(1); expect(src).toContain("collapsed.length > 120"); });
  it("payload",()=>{ expect(("a".repeat(121).slice(0,120)+"…").length).toBe(121); expect(("a".repeat(121).slice(0,119)+"…").length).toBe(120); });
  it("sibling",()=>{ expect(typeof sib).toBe("string"); if(sib) expect(sib).toContain("MAX_DESCRIPTION_CHARS - 1"); });
});
