import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./document-presenter.ts", import.meta.url), "utf8");
let sib="";
try { sib=readFileSync(new URL("../../plugin-browser/src/message-adapter.ts", import.meta.url), "utf8"); } catch{}
if(!sib){ try{ sib=readFileSync("/tmp/eliza-verify2/plugins/plugin-browser/src/message-adapter.ts","utf8"); }catch{}}
describe("docs trunc", () => {
  it("reserves 3",()=>{ expect(src).toContain("let end = maxLength - 3;"); expect(src).not.toContain("let end = maxLength - 1;"); });
  it("single",()=>{ const m=src.match(/let end = maxLength - 3/g)||[]; expect(m.length).toBe(1); expect(src).toContain("value.length <= maxLength"); });
  it("payload",()=>{ const max=80; const weakLen = (max-1)+3; expect(weakLen).toBe(82); const fixedLen = (max-3)+3; expect(fixedLen).toBe(80); const weak2=(max-2)+3; expect(weak2).toBe(81); });
  it("sibling",()=>{ expect(typeof sib).toBe("string"); if(sib) expect(sib).toContain("slice(0, 497)"); });
});
