process.exit = ((c)=>{throw new Error("__EXIT_"+c+"__");});
import fs from "node:fs";
const names = JSON.parse(fs.readFileSync("/tmp/verify-names.json","utf8"));
const t0=Date.now(); await import("@elizaos/core"); process.stderr.write(`core ${Date.now()-t0}ms\n`);
const bad=[];
let ok=0;
for (const n of names) {
  let timer; const to=new Promise((_,rej)=>{timer=setTimeout(()=>rej(new Error("__TIMEOUT__")),25000);});
  try { await Promise.race([import(n), to]); clearTimeout(timer); ok++; }
  catch(e){ clearTimeout(timer); const m=e.message||""; if(/^__EXIT_/.test(m)){ok++;} else bad.push([n, m==="__TIMEOUT__"?"TIMEOUT":"ERR", m.slice(0,90)]); }
}
process.stderr.write(`\n=== ${ok}/${names.length} load OK by specifier under node+tsx (real runtime) ===\n`);
for (const b of bad) process.stderr.write(`  ${b[1]}  ${b[0]}  ${b[2]}\n`);
