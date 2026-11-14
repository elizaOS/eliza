import fs from "node:fs";
import path from "node:path";
import type * as TS from "typescript";
import ts from "typescript";
import { generate, type Model, type Origin } from "./gen.ts";
import { writeConformance } from "./conform.ts";
import { simulated } from "./gen/harness.ts";
import { fail } from "./gen/types.ts";
import type { Unit } from "./prove.ts";
import { run } from "./run.ts";
import { importedMeanings, originalColumn, type Spec } from "./parse.ts";
import { defines } from "./review.ts";
import { entry, recall, store, type Memory } from "./cache.ts";
import { plainText } from "./scan.ts";
import { codeDirOf, codeDirs, filesUnder, owner, readSrc, type SrcFile } from "./util.ts";
import { effectAdapter } from "./gen/vibe.ts";

const ANNOTATIONS = ["backend", "pure", "requires", "ensures", "invariant", "decreases", "type", "ghost", "assert"];

/**
 * gen/ holds TypeScript that Node loads as ES modules, whatever the project's package.json says: a project whose
 * package.json says `"type": "commonjs"` would otherwise fail to load every generated module.
 */
function genDir(root: string): string {
  const dir = path.join(root, "gen");
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, "package.json");
  if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, `${JSON.stringify({ type: "module" })}\n`);
  return dir;
}

/** Quint's errors, at their places in the Markdown: tangling keeps line numbers. */
function typeErrors(spec: Spec, ir: any, out: string, specs: Spec[]): Error {
  const errors = (ir?.errors ?? []).map((e: any) => {
    const at = e.locs?.[0];
    const owner = specs.find((s) => s.name === path.basename(at?.source ?? "", ".qnt")) ?? spec;
    const col = at && originalColumn(owner.tangled, owner.qnt, at.start.line, at.start.col);
    return at ? `${owner.file}:${at.start.line + 1}${col === undefined ? "" : `:${col + 1}`}  ${e.explanation}` : e.explanation;
  });
  return new Error(errors.join("\n") || out);
}

/** The model of a spec, from Quint's typed IR: gen/<name>.ts and its simulation harness. `models` receives it. */
export function generated(root: string, spec: Spec, ir: any, models: Map<string, Model>): Model {
  const dir = genDir(root);
  const top = new Set<string>((ir.modules?.find((m: any) => m.name === spec.name)?.declarations ?? [])
    .filter((d: any) => d.kind === "def" || d.kind === "typedef").map((d: any) => d.name));
  const assigned = new Set(spec.rules.flatMap(defines));
  const untracked = [...top].find((name) => !assigned.has(name) && !spec.builtins.includes(name));
  if (untracked) {
    const rule = spec.rules.find((r) => r.locals.includes(untracked));
    throw new Error(`${spec.file}:${rule?.line ?? 1}: \`${untracked}\` is a top-level definition with no rule assignment; start it on its own line in the same column as the definition above it`);
  }
  const origins = new Map<string, Origin>();
  for (const r of spec.rules) for (const d of r.defs) origins.set(d, { rule: r.key, line: r.line });
  const model = generate(ir, spec.name, spec.file, (d) => origins.get(d), models);
  fs.writeFileSync(path.join(dir, `${spec.name}.ts`), model.ts);
  fs.writeFileSync(path.join(dir, `${spec.name}.run.qnt`), model.harness);
  fs.writeFileSync(path.join(dir, `${spec.name}.effect.vibe`), effectAdapter(spec.name, model.source, model.ts, namespace(root)));
  if (model.opaques.length) fs.writeFileSync(path.join(dir, `${spec.name}.sim.qnt`), simulated(spec.qnt, model.opaques));
  writeConformance(root, model);
  models.set(spec.name, model);
  return model;
}

/**
 * What tells the `Machine` services of one package from another's (gen/vibe.ts): the package's name, or else its path
 * from the workspace or repository root, "." for that root, or its directory's name where there is neither. Never
 * where a checkout happens to be, which would differ from one machine to the next in generated and built code.
 */
function namespace(dir: string): string {
  const manifest = path.join(dir, "package.json");
  const name: unknown = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).name : undefined;
  if (typeof name === "string" && name) return name;
  const real = fs.realpathSync(dir);
  for (let up = real; ; up = path.dirname(up)) {
    if (["pnpm-workspace.yaml", ".git"].some((f) => fs.existsSync(path.join(up, f)))) return path.relative(up, real).split(path.sep).join("/") || ".";
    if (up === path.dirname(up)) return path.basename(real);
  }
}

/**
 * Each owner's gen/, written anew from the root's: the modules of its specs and of every spec they import, under the
 * root's module names, with the types their drivers are written to, so that a package imports only from its own gen/.
 * An Effect adapter is written for the owner, whose name its `Machine` key carries: that is the package the service
 * runs in.
 * A module not generated, because its spec is not valid, is not there.
 */
export function mirrorGen(root: string, specs: Spec[]) {
  const from = path.join(root, "gen");
  for (const dir of codeDirs(root).filter(Boolean)) {
    const needed = new Set<string>();
    const need = (name: string) => { if (!needed.has(name)) { needed.add(name); specs.find((s) => s.name === name)?.imports.forEach(need); } };
    for (const spec of specs) if (`${owner(root, spec.file)}/` === dir) need(spec.name);
    const to = path.join(root, dir, "gen");
    fs.rmSync(to, { recursive: true, force: true });
    const files = fs.readdirSync(from).filter((f) => needed.has(f.match(/^(\w+)\.(?:ts|conformance\.ts)$/)?.[1] ?? ""));
    if (!files.length) continue;
    fs.mkdirSync(to, { recursive: true });
    for (const f of [...files, "package.json", ...files.some((f) => f.endsWith(".conformance.ts")) ? ["_conformance.ts"] : []]) fs.copyFileSync(path.join(from, f), path.join(to, f));
    for (const spec of specs) if (files.includes(`${spec.name}.ts`))
      fs.writeFileSync(path.join(to, `${spec.name}.effect.vibe`), effectAdapter(spec.name, spec.file, fs.readFileSync(path.join(from, `${spec.name}.ts`), "utf8"), namespace(path.join(root, dir))));
  }
}

/**
 * Quint's typed IR of every spec, typechecked all at once and without blocking, or remembered: it depends only on the
 * Quint of the spec and of what it imports. Each promise rejects with the errors of its spec. gen/<name>.qnt is written
 * for every spec, since the simulation harness imports it.
 */
export function typecheckAll(memory: Memory, specs: Spec[]): Map<string, Promise<any>> {
  const dir = genDir(memory.root);
  for (const spec of specs) fs.writeFileSync(path.join(dir, `${spec.name}.qnt`), spec.qnt);
  return new Map(specs.map((spec) => {
    const ir = (async () => {
      const at = await entry(memory.root, "model", [importedMeanings(spec, specs), spec.meaning]);
      const known = recall<any>(memory, at);
      if (known !== undefined) return known;
      const out = path.join(dir, `${spec.name}.ir.json`);
      const typed = await run("quint", ["typecheck", "--out", out, `gen/${spec.name}.qnt`], memory.root);
      let ir: any;
      try { ir = JSON.parse(fs.readFileSync(out, "utf8")); } catch { ir = undefined; }
      fs.rmSync(out, { force: true });
      if (!typed.ok || !ir || ir.errors?.length) throw typeErrors(spec, ir, typed.out, specs);
      store(memory, at, ir);
      return ir;
    })();
    ir.catch(() => {}); // a spec that is not valid is reported in its turn, not as an unhandled rejection
    return [spec.name, ir] as const;
  }));
}

/**
 * LemmaScript verifies one file at a time and does not carry definitions across
 * imports, so every unit is proved as a bundle: what it imports, then itself.
 * An imported module comes with its names prefixed by the module's name and
 * without its own obligations, which are proved once, in its own unit; that
 * keeps the cost of a proof proportional to the module, not to everything
 * beneath it. What an imported module's own unit proved (each clause of its
 * `_ensures` lemmas) is offered to the unit's proof file as a lemma; nothing
 * else of it is.
 *
 * A unit may have a proof file: spec/<name>.proof.dfy for a spec,
 * src/<path>.proof.dfy for src/<path>.ts.
 */
export function proofUnits(root: string, models: Model[], srcFiles: SrcFile[] = readSrc(root)): Unit[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const withoutImports = (text: string) => {
    const file = ts.createSourceFile("unit.ts", text, ts.ScriptTarget.Latest, true);
    // `export … from` loads a module as surely as `import` does.
    const imports = file.statements.filter((d): d is TS.ImportDeclaration | TS.ExportDeclaration => ts.isImportDeclaration(d) || (ts.isExportDeclaration(d) && !!d.moduleSpecifier));
    const kept = imports.reduceRight((rest, d) => rest.slice(0, d.getFullStart()) + rest.slice(d.getEnd()), text);
    return { kept, from: imports.map((d) => (d.moduleSpecifier as TS.StringLiteral).text) };
  };
  const withoutObligations = (text: string) => text.replace(/^\s*\/\/@ ensures .*\n/gm, "");
  /** The modules a module needs beside it, dependencies first. */
  const needs = (m: Model, seen: string[] = []): string[] => {
    for (const dep of m.imports) if (!seen.includes(dep)) { needs(byName.get(dep)!, seen); seen.push(dep); }
    return seen;
  };
  const asDependency = (name: string, docs: boolean) => withoutObligations(withoutImports(byName.get(name)!.render(`${name}_`, docs)).kept);
  /** A module after what it needs, in its own names; `docs` keeps the doc comments, which the cache key leaves out. */
  const bundle = (m: Model, docs: boolean) => [...needs(m).map((n) => asDependency(n, docs)), withoutImports(m.render("", docs)).kept];
  /** The definitions whose `_ensures` lemma a module's own unit proves (gen/typescript.ts). */
  const proving = (m: Model) => [...m.laws.map((l) => l.name), ...(m.stateType ? [...m.transitions.map((t) => t.name), "step", "initialHolds"] : [])];
  /** Modules placed beside a unit, each with the prefix the unit spells it with: their text with their obligations, and those lemmas. */
  const imported = (beside: [string, string][]): Unit["imports"] => ({
    text: beside.map(([n, prefix]) => withoutImports(byName.get(n)!.render(prefix, false)).kept).join("\n"),
    lemmas: beside.flatMap(([n, prefix]) => proving(byName.get(n)!).map((def) => ({ fn: `${prefix}${def}`, def, from: `${n}.ts` }))),
  });
  const prefixed = (names: string[]) => names.map((n): [string, string] => [n, `${n}_`]);
  /** What a unit takes on trust from its module's opaque functions: their types, and the laws stated with them. */
  const assumptions = (m: Model | undefined) => ({ externs: m?.opaques.map((o) => o.name) ?? [], assumed: m?.opaques.flatMap((o) => o.laws.map((l) => l.name)) ?? [] });
  const units: Unit[] = models.map((m) => ({
    unit: `${m.name}.ts`,
    text: bundle(m, true).join("\n"),
    meaning: bundle(m, false).join("\n"),
    src: false,
    proofFile: m.source.replace(/\.md$/, ".proof.dfy"),
    imports: imported(prefixed(needs(m))),
    // Proved against the definitions of what it imports, never against their obligations; but the abstract rules
    // carry over to a refining spec only as far as the machine it refines proved them (SPEC.md, "Refinement").
    rests: m.refines ? [`${m.refines.of.module}.ts`] : [],
    ...assumptions(m),
    transitions: m.stateType ? m.transitions.map((t) => ({ name: t.name, params: t.params.map((p) => p.name) })) : undefined,
  }));

  const other = srcFiles.find((u) => !u.ts);
  if (other) throw new Error(`${other.file}: \`//@\` appears in it, but only .ts files under src/ are proved; rename it to .ts or remove the annotations`);
  for (const { file: f, code } of srcFiles.filter((u) => u.ts)) {
    // Wherever `//@` appears, even after other text on the line, LemmaScript may read it.
    const used = [...code.matchAll(/\/\/@\s*([\w-]*)/g)].map((m) => m[1]);
    const refused = used.find((k) => !ANNOTATIONS.includes(k));
    if (refused !== undefined) throw new Error(`${f}: \`//@ ${refused}\` is not allowed; verified code may only use ${ANNOTATIONS.join(", ")}`);
    if (/\bimport\s*\(|\brequire\s*\(/.test(code)) throw new Error(`${f}: verified code may not load other code with import() or require()`);
    checkVerifiedSource(f, code);
    const { kept, from } = withoutImports(code);
    const deps = from.map((spec) => {
      // The gen/ of the file's own package: the root's, or the one an owner is given (mirrorGen).
      const target = path.resolve(root, path.dirname(f), spec);
      return models.find((m) => target === path.join(root, `${codeDirOf(f)}gen/${m.name}.ts`))?.name ?? fail(`${f}: verified code may only import generated modules (gen/<name>.ts), not ${spec}`);
    });
    if (new Set(deps).size > 1) throw new Error(`${f}: verified code may import one generated module; put what it needs from the others into that module's spec`);
    // The module it imports sits beside it under its own names, as the code refers to them.
    const d = deps[0];
    const beside = (docs: boolean) => d ? bundle(byName.get(d)!, docs).map(withoutObligations) : [];
    units.push({
      requires: used.filter((k) => k === "requires").length,
      unit: f.replaceAll("/", "-"),
      text: [...beside(true), `// ---- ${f} ----`, kept].join("\n"),
      // The hand-written code exactly as it is: only what the tools generated is read without its citations.
      meaning: [...beside(false), `// ---- ${f} ----`, kept].join("\n"),
      src: true,
      proofFile: f.replace(/\.ts$/, ".proof.dfy"),
      imports: imported(d ? [...prefixed(needs(byName.get(d)!)), [d, ""]] : []),
      rests: d ? [...needs(byName.get(d)!), d].map((m) => `${m}.ts`) : [],
      ...assumptions(d ? byName.get(d) : undefined),
    });
  }
  const twice = units.find((u, i) => units.findIndex((v) => v.unit === u.unit) !== i);
  if (twice) throw new Error(`two files would be proved under the name ${twice.unit}; rename one of them`);
  return units;
}

/**
 * Refuse in hand-written verified code what the proof would read one way and Node another: a renamed, default or
 * namespace import, an export other than of a function, constant, type or interface declared in the file, any other
 * top-level statement (LemmaScript does not model one, though Node runs it), and a `//@` that is not in a `//`
 * comment (one in a block comment or a string is not an annotation, though it looks like one), and the names `Std` and
 * `ProofLib`, which the proof gives to Dafny's libraries. And NUL, which no source needs.
 */
export function checkVerifiedSource(file: string, code: string) {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const refuse = (at: number, why: string): never => { throw new Error(`${file}:${sf.getLineAndCharacterOfPosition(at).line + 1}: ${why}`); };
  plainText(file, code);
  for (const s of sf.statements) {
    const modifier = (ts.canHaveModifiers(s) ? ts.getModifiers(s) ?? [] : []).find((m) => m.kind !== ts.SyntaxKind.ExportKeyword);
    if (modifier) refuse(modifier.getStart(), `\`${modifier.getText()}\` is not allowed in verified code`);
    const clause = ts.isImportDeclaration(s) ? s.importClause : undefined;
    const bindings = clause?.namedBindings;
    if (clause?.name || (bindings && ts.isNamespaceImport(bindings))) refuse(s.getStart(), "verified code may import only by name (`import { a, type B } from ...`): not a default or namespace import");
    const renamed = bindings && ts.isNamedImports(bindings) && bindings.elements.find((e) => e.propertyName);
    if (renamed) refuse(renamed.getStart(), `\`${renamed.getText()}\`: verified code may not rename what it imports, since the proof reads the name as written`);
    const allowed = ts.isImportDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)
      || (ts.isFunctionDeclaration(s) && !!s.body && !s.asteriskToken)
      || (ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const);
    if (!allowed) refuse(s.getStart(), "verified code may hold only imports, functions with a body, interfaces, type aliases and const declarations, each exported in its own declaration or not at all");
  }
  // Comments may lead or trail a token; JSDoc is skipped, since its parts lie inside a comment.
  const lineComments: [number, number][] = [];
  const visit = (n: TS.Node) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (ts.isIdentifier(n) && (n.text === "Std" || n.text === "ProofLib")) {
      const declaration = n.parent;
      if ((ts.isVariableDeclaration(declaration) || ts.isParameter(declaration) || ts.isFunctionDeclaration(declaration)
        || ts.isFunctionExpression(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
        || ts.isTypeParameterDeclaration(declaration) || ts.isBindingElement(declaration) || ts.isImportSpecifier(declaration)
        || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) && declaration.name === n)
        refuse(n.getStart(), `\`${n.text}\` names a Dafny library in the proof; use another name`);
    }
    for (const c of [...(ts.getLeadingCommentRanges(code, n.pos) ?? []), ...(ts.getTrailingCommentRanges(code, n.end) ?? [])])
      if (c.kind === ts.SyntaxKind.SingleLineCommentTrivia) lineComments.push([c.pos, c.end]);
    n.getChildren(sf).forEach(visit);
  };
  visit(sf);
  for (const m of code.matchAll(/\/\/@/g))
    if (!lineComments.some(([from, to]) => from <= m.index && m.index < to)) refuse(m.index, "`//@` here is not in a `//` comment (it is in a block comment or a string), so it is not an annotation; remove it or make it one");
}

/** Every proof file of the project. */
export const proofFiles = (root: string) => ["spec", ...codeDirs(root).map((dir) => `${dir}src`)].flatMap((dir) => filesUnder(root, dir)).filter((f) => f.endsWith(".proof.dfy"));

/** Proof files that belong to no unit: a typo, or a source file that is no longer proved. */
export const strayProofFiles = (root: string, units: Unit[]) => proofFiles(root).filter((f) => !units.some((u) => u.proofFile === f));
