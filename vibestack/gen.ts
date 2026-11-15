// Quint IR -> TypeScript. Reads the JSON that `quint typecheck --out` writes for a
// pure module and emits one TypeScript module annotated for LemmaScript, plus a
// Quint harness module that drives the same definitions for simulation.
//
// The supported Quint subset is deliberately small; anything outside it throws
// with the name of the construct, so a spec can never be silently mistranslated.
//
// This file reads the module: what it imports, which names it may bind and how a
// name is spelled. The rest is in gen/: types.ts (everything decided by a type),
// print.ts (expressions), classify.ts (which definition is a transition, a guard
// or a rule), secrecy.ts (where a secret may go), typescript.ts and harness.ts (the two outputs).
import { classify, ROLES, type ImportedMachine, type Opaque, type Param, type Roles } from "./gen/classify.ts";
import { harness, HARNESS, type Eval, type Fairness } from "./gen/harness.ts";
import { BUILTIN, printer } from "./gen/print.ts";
import { checkSecrets } from "./gen/secrecy.ts";
import { EMITTED, HELPERS, typescript } from "./gen/typescript.ts";
import { fail, typeOfIn, typeWalks, type Json } from "./gen/types.ts";
import path from "node:path";
import type { ComparisonShape } from "./conformance.ts";

export interface Model extends Roles {
  name: string;
  /** The source in the project, or std/ for a spec shipped with the tools. */
  source: string;
  imports: string[]; // other specs this one imports, in order
  /**
   * The module as the prover reads it, under a prefix for proof bundles; `docs = false` omits spec comments for cache
   * keys. It differs from `ts`, which Node runs, only where `ts` checks at run time what the proof takes as given
   * (Scope.proof in gen/print.ts).
   */
  render: (prefix: string, docs?: boolean) => string;
  /** Events the spec declares fair (`fair_<event>`), each "weak" or "strong". */
  fair: Map<string, Fairness>;
  /** `leadsTo` rules that must also be met within a number of events (`within_<rule>`). */
  within: Map<string, number>;
  evals: Eval[];
  /** Definitions the simulator cannot evaluate on their own, because it has no values for a parameter. */
  uncompared: string[];
  /** A value from a Quint trace (ITF) as the generated TypeScript represents it. */
  decode: (type: Json, itf: any) => any;
  /** The same value with every set in a fixed order, so that two sets compare equal however they were built. */
  canon: (type: Json, value: any) => any;
  /** The shape of state observations, including which arrays are sets and which variant carries them. */
  shape: ComparisonShape | undefined;
  /** The shape of emitted effects, when transitions return them beside the state. */
  outputShape: ComparisonShape | undefined;
  /** What importers may refer to; `visible` includes the types this module imported. */
  exports: { types: string[]; values: string[]; variants: string[]; visible: Json[]; samples: { name: string; elem: Json }[] };
  ts: string;
  harness: string;
}

/** Where a definition came from in the spec, for doc comments and ordering. */
export interface Origin { rule: string; line: number }

/** Names a spec may not bind: the generated code, the harness, Dafny's standard library (Std) or the proof library (ProofLib) use them, or TypeScript reserves them. */
const TAKEN = new Set([...EMITTED, ...HARNESS, ...`
  Std ProofLib Number Math Object Array JSON Record Set Map String Boolean Symbol Error RangeError undefined NaN Infinity globalThis
  break case catch class const continue debugger default delete do else enum export extends false finally for function
  if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await
  eval arguments implements interface package private protected public
`.split(/\s+/).filter(Boolean)]);
const RULE_OR_GUARD = new RegExp(`^(${[...ROLES, "can"].join("|")})[A-Z]`);
const GENERATED = new RegExp(`^(${[...HELPERS, "eval", "Out", "set", "opaque", "table", "else"].join("|")})_|^x\\d+$|__\\d+$`);

export function generate(ir: Json, name: string, source: string, origin: (def: string) => Origin | undefined, deps: Map<string, Model>): Model {
  const decls: Json[] = (ir.modules.find((m: Json) => m.name === name) ?? fail(`module ${name} not found`)).declarations;

  // --- what the module imports -------------------------------------------------
  // `import kernel.* from "./kernel"` brings a library's names in as they are. `import order as O from "./order"`
  // brings any spec in, a state machine included, under the names O::pay, O::Order and so on.
  /** A spec's path below spec/ (or std/), as an import names it. */
  const stem = (file: string) => file.replaceAll(path.sep, "/").replace(/^(?:spec|std)\//, "").replace(/(^|\/)index\.md$|\.md$/, "");
  const links = decls.filter((d) => d.kind === "import").map((d) => {
    const dep = deps.get(d.protoName) ?? fail(`internal: ${d.protoName} has no model`);
    // How this spec writes the import: the path relative to it, and the name it ends in (SPEC.md, "Using one spec from another").
    const rel = path.posix.relative(path.posix.dirname(stem(source)), stem(dep.source));
    const from = rel.startsWith("../") ? rel : `./${rel}`;
    const short = from.split("/").pop()!;
    if (dep.opaques.length) fail(`import of ${short}: it declares opaque functions (${dep.opaques.map((o) => o.name).join(", ")}), which only its own spec can simulate; move them into the spec that imports it`);
    if (d.qualifiedName) return { module: dep.name, exports: dep.exports, alias: d.qualifiedName as string };
    if (d.defName !== "*") fail(`import ${short}: write \`import ${short}.* from "${from}"\` or \`import ${short} as X from "${from}"\``);
    if (dep.stateType) fail(`import of ${short}: a spec with a state of its own is imported under a name, as in \`import ${short} as X from "${from}"\``);
    return { module: dep.name, exports: dep.exports, alias: undefined as string | undefined };
  });
  const imports = links.map((l) => l.module);
  const twice = imports.find((m, i) => imports.indexOf(m) !== i);
  if (twice) fail(`${twice} is imported twice; import a spec once, either as it is or under one name`);
  const qualify = (alias: string | undefined, n: string) => (alias ? `${alias}::${n}` : n);
  /** An imported name as this module writes it, and the module it came from. */
  const imported = (kind: "values" | "variants") => links.flatMap((l) => l.exports[kind].map((n) => [qualify(l.alias, n), l.module] as const));
  const cameFrom = new Map(imported("values"));

  // --- what it defines ------------------------------------------------------------
  const localTypedefs = decls.filter((d) => d.kind === "typedef");
  for (const d of localTypedefs) d.module = name; // so that the harness can name a type by the module that defines it
  const localVariants = localTypedefs.flatMap((t) => (t.type.kind === "sum" ? t.type.fields.fields.map((f: Json) => f.fieldName as string) : []));
  const variants = new Set([...localVariants, ...imported("variants").map(([n]) => n)]);
  const defs = decls.filter((d) => d.kind === "def" && !localVariants.includes(d.name) && !BUILTIN.test(d.name));
  for (const d of [...decls.filter((d) => !["def", "typedef", "import", "const"].includes(d.kind)), ...defs.filter((d) => d.qualifier !== "puredef" && d.qualifier !== "pureval")])
    fail(`${d.name ?? d.kind}: only types, imports, \`pure val\` and \`pure def\` belong in a spec, besides the \`const\` of an opaque function (state and actions are generated)`);
  const inferred = (id: number): Json | undefined => ir.types[id]?.type;
  const typeOf = typeOfIn(inferred);
  // A set named `<param>Values` tells the simulator what to try for a parameter. It never reaches TypeScript, so any Quint is allowed in it.
  const isSampleSet = (d: Json) => d.qualifier === "pureval" && d.name.endsWith("Values") && inferred(d.id)?.kind === "set";
  const ownSamples = defs.filter(isSampleSet).map((d) => ({ name: d.name as string, elem: inferred(d.id)!.elem as Json }));
  // `weight_<event>`, `fair_<event>` and `within_<rule>` tell the simulator how often to try an event, which events a run
  // cannot put off for ever and how soon a `leadsTo` rule is met (SPEC.md, "What goes in the Quint blocks"); like
  // sample sets, they never reach TypeScript.
  const settings = defs.filter((d) => d.qualifier === "pureval" && /^(weight|fair|within)_/.test(d.name));
  const code = defs.filter((d) => !isSampleSet(d) && !settings.includes(d));
  /** Names only the simulator reads; a definition that used one would refer to nothing in TypeScript. */
  const simulatorOnly = new Set([...ownSamples, ...settings, ...links.flatMap((l) => l.exports.samples.map((s) => ({ name: qualify(l.alias, s.name) })))].map((d) => d.name as string));
  // `const f: (A, B) => R` is an opaque function: no body, only the laws stated with it (SPEC.md, "Opaque functions").
  const consts = decls.filter((d) => d.kind === "const");
  for (const d of consts) if (d.typeAnnotation?.kind !== "oper" || !d.typeAnnotation.args.length) fail(`${d.name}: a \`const\` is an opaque function, written \`const ${d.name}: (A, B) => R\` on one line`);
  const localNames = new Set([...code, ...consts].map((d) => d.name as string));
  const beneath = (m: string): string[] => [m, ...deps.get(m)!.imports.flatMap(beneath)];
  const prefixes = [...new Set(imports.flatMap(beneath))];
  /** A name the spec binds (a type, definition, parameter or local `val`) must survive translation unchanged. */
  const bind = (n: string): string => {
    const owner = prefixes.find((m) => n.startsWith(`${m}_`));
    return TAKEN.has(n) || GENERATED.test(n) ? fail(`\`${n}\` cannot be used as a name: TypeScript or the generated code uses it`)
      : variants.has(n) ? fail(`\`${n}\` is a variant of a type and cannot also name a parameter or value`)
      : owner ? fail(`\`${n}\` cannot be used as a name: names beginning ${owner}_ are how the generated code refers to that module`)
      : n;
  };
  [...defs, ...localTypedefs, ...consts].forEach((d) => bind(d.name));

  // --- types: the module's own, and those of what it imports under the names it knows them by ---
  /** A type from a module imported under a name, with the types it mentions renamed the same way. */
  const requalify = (t: Json, alias: string | undefined): Json =>
    !alias || t === null || typeof t !== "object" ? t
    : Array.isArray(t) ? t.map((x) => requalify(x, alias))
    : t.kind === "const" ? { ...t, name: qualify(alias, t.name) }
    : Object.fromEntries(Object.entries(t).map(([k, v]) => [k, requalify(v, alias)]));
  // Every type a module can name comes along with it, including what it imported itself: a machine whose state holds a
  // library's type is imported under a name together with that type (as M::T), however deep the import.
  const seen = new Set<string>();
  const typedefs = [
    ...links.flatMap((l) => l.exports.visible.map((d) => ({ ...d, type: requalify(d.type, l.alias), name: qualify(l.alias, d.name), alias: l.alias ?? d.alias, base: d.base ?? d.name }))),
    ...localTypedefs,
  ].filter((d) => !seen.has(d.name) && !!seen.add(d.name));
  /** Modules whose types this one names without importing them itself; the harness and the TypeScript import them too. */
  const typeOnly = [...new Set(typedefs.map((d) => d.module as string))].filter((m) => m !== name && !imports.includes(m)).sort();
  const types = typeWalks(typedefs, name);
  /**
   * What each sample set holds, how the harness names it and, for the spec's own, where the spec defines it, so that
   * the harness can hold it to the parameter it is for. The sets of the specs this one imports apply too; its own win.
   */
  const samples = new Map<string, { elem: Json; ref: string; line: number | undefined }>([
    ...links.flatMap((l) => l.exports.samples.map((s) => [s.name, { elem: requalify(s.elem, l.alias), ref: `D_${l.module}::${s.name}`, line: undefined }] as const)),
    ...ownSamples.map((s) => [s.name, { elem: s.elem, ref: `M::${s.name}`, line: origin(s.name)?.line }] as const),
  ]);

  // --- definitions, by the naming convention ----------------------------------------
  const sig = (d: Json) => {
    const t = typeOf(d.id);
    const params: Param[] = d.expr.params.map((p: Json, i: number) => ({ name: bind(p.name), type: t.args[i] }));
    return { params, result: t.res };
  };
  const bySpecOrder = (x: Json, y: Json) => (origin(x.name)?.line ?? 0) - (origin(y.name)?.line ?? 0);
  const vals = code.filter((d) => d.qualifier === "pureval");
  const funs = code.filter((d) => d.qualifier === "puredef").sort(bySpecOrder);
  for (const d of funs) if (d.expr.kind !== "lambda") fail(`${d.name}: a \`pure def\` takes parameters; for a constant write \`pure val ${d.name} = …\``);
  // A rule must be a definition: as a `pure val` it would be generated as a constant and never checked.
  for (const v of vals) if (RULE_OR_GUARD.test(v.name) && typeOf(v.id).kind === "bool") fail(`${v.name}: a rule or guard is a \`pure def\` with parameters (SPEC.md, "What goes in the Quint blocks"), not a \`pure val\`; if it is a constant, name it otherwise`);
  const initial = vals.find((d) => d.name === "initial");
  // The machines imported under a name, as this module spells their types: what a `refines<Alias>` may map onto.
  const machines = links.flatMap((l): ImportedMachine[] => {
    const dep = deps.get(l.module)!;
    const spelled = (t: Json) => requalify(t, l.alias);
    return l.alias && dep.stateType ? [{ alias: l.alias, module: l.module, stateType: spelled(dep.stateType),
      transitions: dep.transitions.map((t) => ({ ...t, params: t.params.map((p) => ({ ...p, type: spelled(p.type) })) })) }] : [];
  });
  const declared = classify(funs, initial && typeOf(initial.id), sig, types, machines);
  const at = (d: string) => `${d} (${source}${origin(d) ? `:${origin(d)!.line}` : ""})`;
  // The laws in an opaque function's rule are what is assumed of it; every other law is proved.
  const opaques: Opaque[] = consts.map((d) => {
    const params: Param[] = d.typeAnnotation.args.map((type: Json, i: number) => ({ name: `p${i}`, type }));
    if (!params.every((p) => types.isScalar(p.type))) fail(`${at(d.name)}: an opaque function takes only simple values (int, bool, str or a plain variant), which the simulator can tabulate`);
    return { name: d.name, params, result: d.typeAnnotation.res, laws: declared.laws.filter((l) => origin(l.name)?.rule === origin(d.name)?.rule) };
  });
  const roles: Roles = { ...declared, laws: declared.laws.filter((l) => !opaques.some((o) => o.laws.includes(l))), opaques };
  checkSecrets({ funs, vals, sig, inferred, where: at, variants }, roles, types);
  const events = roles.transitions.map((t) => t.name);
  const setting = (kind: string, targets: string[], what: string, ok: (e: Json) => boolean, want: string) => new Map(settings.filter((d) => d.name.startsWith(`${kind}_`)).map((d) => {
    const target = d.name.slice(kind.length + 1);
    if (!targets.includes(target)) fail(`${at(d.name)}: there is no ${what} named ${target}; name it \`${kind}_<${what}>\``);
    return [target, ok(d.expr) ? d.expr.value : fail(`${at(d.name)}: write ${want}`)];
  }));
  const count = (e: Json) => e.kind === "int" && e.value >= 1 && e.value <= 100;
  const weights = setting("weight", events, "transition", count, "a whole number from 1 to 100: how many times as often as an event of weight 1 the simulator tries it");
  const within = setting("within", roles.leadsTo, "leadsTo rule", count, "a whole number from 1 to 100: the most events a run may take before it meets the rule");
  const fair = setting("fair", events, "transition", (e) => e.kind === "str" && ["weak", "strong"].includes(e.value), '"weak" (taken if it stays possible) or "strong" (taken if it keeps becoming possible)') as Map<string, Fairness>;
  if (fair.size && !roles.leadsTo.length) fail(`${[...fair.keys()].map((e) => `fair_${e}`).join(", ")}: fairness matters only to \`leadsTo\` rules, and the spec has none`);

  // --- TypeScript -------------------------------------------------------------------
  // A heading is prose from the spec; it must not be able to end the comment it is quoted in.
  const doc = (d: string) => (origin(d) ? `/** ${origin(d)!.rule.replace(/\*\//g, "* /").replace(/[\r\n]+/g, " ")} (${source}:${origin(d)!.line}) */\n` : "");
  const importLine = (l: (typeof links)[number]) => {
    const item = (n: string, isType: boolean) => `${isType ? "type " : ""}${n} as ${l.module}_${n}`;
    return `import { ${[...l.exports.types.map((t) => item(t, true)), ...l.exports.values.map((v) => item(v, false))].join(", ")} } from "./${l.module}.ts";`;
  };
  const header = [
    `// GENERATED from ${source} by vibestack/spec.ts. Do not edit: change the spec and run \`pnpm gen\`.`,
    `//@ backend dafny`,
    ...links.map(importLine),
    ...typeOnly.map((m) => `import { ${[...new Set(typedefs.filter((d) => d.module === m).map((d) => d.base as string))].map((b) => `type ${b} as ${m}_${b}`).join(", ")} } from "./${m}.ts";`),
  ];
  /** The module's TypeScript with its own top-level names under a prefix. */
  const render = (prefix: string, docs = true, proof = true): string => {
    const local = (n: string) => prefix + n;
    const helper = (which: string) => local(`${which}_${name}`);
    // A definition from another module is spelled <module>_<name>, however it was imported.
    const ref = (n: string) => (localNames.has(n) ? local(n) : cameFrom.has(n) ? `${cameFrom.get(n)}_${n.split("::").pop()}` : n);
    const scoped = typeWalks(typedefs, name, prefix);
    const print = printer({ types: scoped, inferred, ref, helper, bind, variants, definitions: new Set([...localNames, ...cameFrom.keys()]), simulatorOnly, proof });
    return typescript({ header, typedefs: [...localTypedefs].sort(bySpecOrder), vals, funs, sig, typeOf, doc: docs ? doc : () => "", local, source }, roles, scoped, print, helper);
  };
  const ts = render("", true, false);

  const run = harness(name, source, [...imports, ...typeOnly], funs, sig, samples, roles, types, { weights, fair });
  return {
    name, source, imports, ...roles, fair, within, evals: run.evals, uncompared: run.uncompared, harness: run.text,
    ts, render, decode: types.decode, canon: types.canon,
    shape: roles.stateType ? types.comparison(roles.stateType) : undefined,
    outputShape: roles.output ? types.comparison(roles.output.out) : undefined,
    exports: { types: localTypedefs.map((d) => d.name as string), values: [...localNames], variants: localVariants, visible: typedefs, samples: ownSamples },
  };
}
