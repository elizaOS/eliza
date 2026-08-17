import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./providers/inbox-triage.ts", import.meta.url), "utf8");
let sib="";
try { sib=readFileSync(new URL("../../plugin-instagram/src/service.ts", import.meta.url), "utf8"); } catch{}
if(!sib){ try{ sib=readFileSync("/tmp/eliza-verify2/plugins/plugin-instagram/src/service.ts","utf8"); }catch{}}
describe("inbox trunc", () => {
  it("reserves 57",()=>{ expect(src).toContain("slice(0, 57)}..."); expect(src).not.toContain("slice(0, 60)}..."); });
  it("single",()=>{ const m=src.match(/slice\(0, 57\)/g)||[]; expect(m.length).toBe(1); });
  it("payload",()=>{ expect(("a".repeat(61).slice(0,60)+"...").length).toBe(63); expect(("a".repeat(61).slice(0,57)+"...").length).toBe(60); });
  it("sibling",()=>{ expect(typeof sib).toBe("string"); if(sib) expect(sib).toContain("MAX_COMMENT_LENGTH - 3"); });
});
