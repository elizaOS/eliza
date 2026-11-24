// Prove selected units as `spec check` would, without the rest of the check.
// usage: node prove-units.ts <root> [--deps] <unit>...   (unit names without .ts)
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(process.argv[2]);
let args = process.argv.slice(3);
const withDeps = args.includes("--deps");
args = args.filter((a) => a !== "--deps");
const V = (f: string) => path.join(root, "vibestack", f);
const { readSpecs, located } = await import(V("parse.ts"));
const { typecheckAll, generated, proofUnits } = await import(V("units.ts"));
const { prove, proofPaths, ensuresOf, LIB_FILE, libraryFor } = await import(V("prove.ts"));
const { readReviewLock } = await import(V("review.ts"));
const { sha } = await import(V("util.ts"));
const lock = readReviewLock(root);
const listOnly = args.includes("--list");
args = args.filter((a) => a !== "--list");
const memory = { root, fresh: false, used: new Set<string>() };
const specs = readSpecs(root);
const staged = new Map<string, string>();
const typed = typecheckAll(memory, specs, root, staged);
const models = new Map();
const list: any[] = [];
for (const spec of specs) {
  const ir = await typed.get(spec.name);
  const m = generated(root, spec, ir, models, staged);
  models.set(spec.name, m);
  list.push(m);
}
const units = proofUnits(root, list);
const byUnit = new Map(units.map((u: any) => [u.unit, u]));
if (args[0] === "--dump") {
  fs.mkdirSync(args[1], { recursive: true });
  for (const u of units as any[]) fs.writeFileSync(path.join(args[1], u.unit), u.text);
  process.exit(0);
}
if (args[0] === "--gen") {
  const { bin } = await import(V("run.ts"));
  const { execFileSync } = await import("node:child_process");
  for (const a of args.slice(1)) {
    const u: any = byUnit.get(`${a}.ts`);
    const d = path.join(root, "gen/proof-raw", a);
    fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, u.unit), u.text);
    fs.writeFileSync(path.join(d, "lemmascript.json"), JSON.stringify({ "unread-annotations": "error", "run-log": false }));
    fs.writeFileSync(path.join(d, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2023", lib: ["es2023"], module: "nodenext", strict: true, noEmit: true, allowImportingTsExtensions: true, types: [] }, files: [u.unit] }));
    try { execFileSync(bin("lsc", root), ["gen", "--backend=dafny", u.unit], { cwd: d, stdio: "inherit" }); } catch (e) { console.log(`lsc failed for ${a}`); }
    console.log(`wrote ${d}`);
  }
  process.exit(0);
}
if (listOnly) { for (const u of units) console.log(u.unit, u.proofFile, u.src ? "src" : ""); process.exit(0); }
const lib = fs.readFileSync(LIB_FILE, "utf8");
const results = new Map<string, any>();
async function run(name: string): Promise<any> {
  const unit = name.endsWith(".ts") ? name : `${name}.ts`;
  if (results.has(unit)) return results.get(unit);
  const p = (async () => {
    const u: any = byUnit.get(unit);
    if (!u) throw new Error(`no unit ${unit}`);
    const proofPath = located(root, u.proofFile);
    const proofText = fs.existsSync(proofPath) ? fs.readFileSync(proofPath, "utf8") : undefined;
    const imports = proofText === undefined ? [] : u.imports.lemmas;
    let offered: any[];
    if (withDeps) {
      offered = [];
      for (const { fn, def, from } of imports) {
        const d = await run(from);
        if (!d || d.errors.length) continue;
        const clauses = ensuresOf(d.dfy, `${def}_ensures`).map((c: string) => `${def}: ${c}`);
        const failed = d.unproved.filter((x: string) => x.startsWith(`${def}: `));
        const known = failed.every((x: string) => clauses.includes(x));
        const proved = clauses.map((c: string) => known && !failed.includes(c));
        if (proved.length) offered.push({ fn, proved });
      }
    } else offered = imports.map(({ fn }: any) => ({ fn }));
    const proof = await prove(memory, u, { proof: proofText === undefined ? undefined : { file: u.proofFile, text: proofText }, lib, axioms: offered });
    const { log, dfy, scaffold } = proofPaths(u.unit);
    fs.mkdirSync(path.dirname(path.join(root, dfy)), { recursive: true });
    fs.writeFileSync(path.join(root, log), proof.log);
    fs.writeFileSync(path.join(root, dfy), proof.dfy);
    if (proof.scaffold) fs.writeFileSync(path.join(root, scaffold), proof.scaffold);
    return proof;
  })();
  results.set(unit, p);
  return p;
}
const out: any = {};
await Promise.all(args.map(async (a) => {
  const p = await run(a);
  const u: any = byUnit.get(a.endsWith(".ts") ? a : `${a}.ts`);
  const pp = located(root, u.proofFile);
  const pt = fs.existsSync(pp) ? fs.readFileSync(pp, "utf8") : undefined;
  const meaning = sha(u.meaning, pt ?? "").slice(0, 12);
  const was = lock.unproved[u.unit];
  const valid = !u.src && was?.text === meaning ? was.unproved : [];
  const fresh = p.unproved.filter((x: string) => !valid.includes(x));
  const pass = !p.errors.length && !(u.src && p.unproved.length) && !fresh.length;
  console.log(`${a}: ${pass ? "PASS" : "FAIL"} fresh=${fresh.length} accepted=${valid.length} lockText=${was?.text === meaning ? "same" : was ? "changed" : "none"}`);
  out[a] = { pass, fresh, proved: p.total - p.unproved.length, total: p.total, errors: p.errors, unproved: p.unproved, exhausted: p.exhausted, resting: p.resting };
  console.log(`${a}: ${p.total - p.unproved.length}/${p.total} proved${p.errors.length ? `, ${p.errors.length} ERRORS` : ""}`);
}));
fs.writeFileSync(path.join(root, "gen/proof/driver-result.json"), JSON.stringify(out, null, 1));
for (const [a, r] of Object.entries<any>(out)) {
  console.log(`\n== ${a}`);
  for (const e of r.errors) console.log(`ERROR: ${e}`);
  for (const x of r.unproved) console.log(`  ${x}${r.exhausted.includes(x) ? " [exhausted]" : ""}${r.resting[x] ? ` [rests on ${r.resting[x]}]` : ""}`);
}
process.exit(0);
