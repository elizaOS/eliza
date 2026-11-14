// The Quint module that drives a spec for simulation: one action per transition, per law, and per definition
// whose arguments the simulator can supply.
import { VIA, type Law, type Opaque, type Param, type Roles, type Transition } from "./classify.ts";
import { fail, type Json, type Types } from "./types.ts";

/** A definition the simulator evaluates so that its result can be compared with TypeScript's. */
export interface Eval { name: string; params: (Param & { from: "state" | "prev" | "emitted" | "pick" })[]; result: Json }

/** A fair event cannot be put off for ever: weakly, while it stays possible; strongly, while it keeps becoming possible. */
export type Fairness = "weak" | "strong";

/** The harness's variables, in the order it declares them. */
const VARS = ["state", "prev", "moved", "last", "lawsHold", "outcome", "emitted", "refined", "fairEnabled", "settled"];
/** Every name the harness binds itself, which a spec parameter would hide (TAKEN in gen.ts). */
export const HARNESS = [...VARS, "fairOn", "init", "settle", "step", "probe", "inv", "Out", "Nothing"];

/** Values the simulator tries for a parameter of each scalar type (the proof covers all values). */
const TRIED: Record<string, string> = { int: "(-1).to(6)", bool: "Set(true, false)", str: 'Set("", "a", "b")' };

export function harness(
  module: string, source: string, imports: string[], funs: Json[], sig: (d: Json) => { params: Param[]; result: Json },
  samples: Map<string, { elem: Json; ref: string; line: number | undefined }>, { stateType, transitions, always, sometimes, steps, laws, opaques, output, refines }: Roles,
  { fields, typedef, resolve, shape, tagged, named, qType }: Types,
  { weights, fair }: { weights: Map<string, number>; fair: Map<string, Fairness> },
): { text: string; evals: Eval[]; uncompared: string[] } {
  const stateShape = stateType && shape(stateType);
  const spell = (t: Json) => { try { return qType(t).replace(/^(M|D_\w+)::/, ""); } catch { return shape(t); } };
  /**
   * The `<param>Values` for a parameter, the spec's own or an imported spec's, if there is one. A set of the spec's own
   * of the wrong type would otherwise surface as a type error inside the generated harness, far from the spec line that
   * causes it; an imported one of another type was meant for another parameter, and is not used.
   */
  const given = (p: Param, of: string): string | undefined => {
    const set = samples.get(`${p.name}Values`);
    if (!set || set.elem.kind === "var" || shape(set.elem) === shape(p.type)) return set?.ref;
    if (set.ref.startsWith("M::"))
      fail(`${p.name}Values (${source}${set.line ? `:${set.line}` : ""}) holds ${spell(set.elem)}, but the parameter ${p.name} of ${of} is ${spell(p.type)}: rename the parameter or the set, as each \`<param>Values\` is used for every parameter of that name`);
  };
  /** How the harness names a variant: by the module that defines its type, which an import may not re-export. */
  const definedIn = (t: Json): Json | undefined => (t.kind === "const" ? (typedef(t.name).type.kind === "const" ? definedIn(typedef(t.name).type) : typedef(t.name)) : named(t, "sum"));
  const variant = (t0: Json, v: string) => { const d = definedIn(t0); return `${!d || d.module === module ? "M" : `D_${d.module}`}::${v}`; };
  /** A Quint set of values to try for a value of a type: the values of an enum, every subset, short lists. */
  const byType = (p: Param, t0: Json): string => {
    const t = resolve(t0);
    if (t.kind === "sum" && !tagged(t)) return `Set(${fields(t).map((f) => variant(t0, f.fieldName)).join(", ")})`;
    if (t.kind === "set") return `${byType(p, t.elem)}.powerset()`;
    if (t.kind === "list") {
      const of = byType(p, t.elem);
      return `Set(List()).union(${of}.map(x => List(x))).union(tuples(${of}, ${of}).map(p => List(p._1, p._2)))`;
    }
    return TRIED[t.kind] ?? fail(`parameter ${p.name}: the simulator has no values to try for type ${t.kind}; define \`pure val ${p.name}Values = Set(...)\` in the spec`);
  };
  /** What the simulator tries for a parameter of `of`: its `<param>Values`, or the default for its type. */
  const tried = (p: Param, of: string) => given(p, of) ?? byType(p, p.type);
  /**
   * Picks for the parameters of `of`. `<param>Values` in the spec overrides the default for its type. A list parameter
   * is up to two independent picks, rather than one pick from the set of every such list, which Quint would build in
   * full on every step (65,536 lists for a List[Set[int]]). The list is still recorded under the parameter's name.
   */
  const takesVia = (name: string) => steps.some((r) => r.name === name && r.via);
  const viaValues = `Set(${transitions.map((t) => JSON.stringify(t.name)).join(", ")})`;
  const picks = (ps: Param[], of: string) => ps.map((p) => {
    const own = takesVia(of) && p.name === VIA ? viaValues : given(p, of);
    const t = resolve(p.type);
    if (own || t.kind !== "list") return `nondet ${p.name} = ${own ?? tried(p, of)}.oneOf() `;
    const [x0, x1] = [`${p.name}__0`, `${p.name}__1`];
    const each = byType(p, t.elem);
    return `nondet ${x0} = ${each}.oneOf() nondet ${x1} = ${each}.oneOf() nondet ${p.name} = Set(List(), List(${x0}), List(${x0}, ${x1})).oneOf() `;
  }).join("");
  const braces = (ps: Param[], of: string, inner: string) => (ps.length ? `{ ${picks(ps, of)}${inner} }` : inner);

  // Every definition whose arguments the simulator can supply is evaluated during simulation, on reachable states
  // and sampled values, so that TypeScript's result can be compared with Quint's. This is the main test of the
  // translation: it covers helpers, guards and rules, not just the states that events lead to.
  const uncompared: string[] = [];
  const evals: Eval[] = funs.flatMap((d): Eval[] => {
    const { params, result } = sig(d);
    // A step rule's `out` is what the last transition output.
    const emitted = steps.some((r) => r.name === d.name && r.out);
    const onStates = stateType ? params.filter((p, i) => !(emitted && i === params.length - 1) && shape(p.type) === stateShape).length : 0;
    let seen = 0;
    const sources = params.map((p, i) => (emitted && i === params.length - 1 ? "emitted" as const
      : stateType && shape(p.type) === stateShape ? (onStates === 2 && seen++ === 0 ? "prev" as const : "state" as const) : "pick" as const));
    params.forEach((p, i) => sources[i] === "pick" && given(p, d.name)); // a mismatched set is a mistake in the spec, not a reason to skip
    try {
      if (onStates > 2) fail("the simulator holds two states at most: the state and the one before it");
      picks(params.filter((_, i) => sources[i] === "pick"), d.name);
      qType(result);
      return [{ name: d.name, params: params.map((p, i) => ({ ...p, from: sources[i] })), result }];
    } catch {
      uncompared.push(d.name); // its arguments cannot be sampled, or its result has no name: it is compared only where events use it
      return [];
    }
  });

  // An opaque function is simulated by a table, chosen for each trace from the values the simulator tries (its
  // `<name>Values` for what it returns), and one of its results for anything else. The tables are variables of the
  // module the harness imports (`simulated`, below). A trace starts once a `settle` step finds that the laws assumed of
  // each hold on its table for every value tried; until then no rule is checked, and a trace whose tables break them
  // ends there, and is dropped (simulate.ts, readTrace).
  const keys = (o: Opaque) => (o.params.length === 1 ? tried(o.params[0], o.name) : `tuples(${o.params.map((p) => tried(p, o.name)).join(", ")})`);
  const results = (o: Opaque) => tried({ name: o.name, type: o.result }, o.name);
  const tables = opaques.flatMap((o) => [`M::opaque_${o.name}`, `M::opaque_${o.name}_else`]);
  const assumed = opaques.flatMap((o) => o.laws.map((l) => l.params.reduceRight((body, p) => `${tried(p, l.name)}.forall(${p.name} => ${body})`, `M::${l.name}(${l.params.map((p) => p.name).join(", ")})`)));
  const chosen = Object.fromEntries(opaques.flatMap((o) => [[`M::opaque_${o.name}`, `table_${o.name}`], [`M::opaque_${o.name}_else`, `else_${o.name}`]]));
  const choose = (inner: string) => opaques.reduceRight((rest, o) =>
    `{ nondet table_${o.name} = setOfMaps(${keys(o)}, ${results(o)}).oneOf() nondet else_${o.name} = table_${o.name}.keys().map(k => table_${o.name}.get(k)).oneOf() ${rest} }`, inner);
  const settled = (action: string) => (opaques.length ? `if (settled) ${action} else settle` : action);

  const declared: Record<string, unknown> = { state: stateType, prev: stateType, moved: stateType, last: stateType, lawsHold: true, outcome: evals.length, emitted: output, refined: refines, fairEnabled: fair.size, settled: opaques.length };
  const vars = [...VARS.filter((v) => declared[v]), ...tables];
  /** What the initial state starts, which may call an opaque function, and so waits for `settle` if there are any. */
  const start = { refined: refines ? `M::${refines.fn}(M::initial) == D_${refines.of.module}::initial` : "", fairEnabled: "fairOn(M::initial)" };
  /** An action body: the given conditions and assignments, with every other variable left as it is. */
  const frame = (conditions: string[], set: Record<string, string>) =>
    `all { ${[...conditions, ...vars.map((v) => `${v}' = ${set[v] ?? v}`)].join(", ")} }`;
  const call = (fn: string, params: string[], from = "state") => `M::${fn}(${[from, ...params].join(", ")})`;
  /** The step from `state` to `after` leaves the abstract state as it was, or is the abstract step of its name (SPEC.md, "Refinement"; gen/typescript.ts). */
  const refined = (t: Transition, after: string) => {
    const A = `D_${refines!.of.module}`;
    const [from, to] = ["state", after].map((s) => `M::${refines!.fn}(${s})`);
    const u = refines!.of.transitions.find((u) => u.name === t.name);
    const guard = u?.guard ? `${A}::${u.guard}(${[from, ...u.guardParams].join(", ")}) and ` : "";
    return `(${to} == ${from}${u ? ` or (${guard}${to} == ${A}::${u.name}(${[from, ...u.params.map((p) => p.name)].join(", ")})${u.emits ? ".state" : ""})` : ""})`;
  };
  const action = (t: Transition) => {
    const result = call(t.name, t.params.map((p) => p.name));
    const after = t.emits ? `${result}.state` : result;
    return `  action ${t.name} = ${braces(t.params, t.name, frame(t.guard ? [call(t.guard, t.guardParams)] : [],
      { state: after, emitted: t.emits ? `${result}.out` : "List()", refined: refines ? refined(t, after) : "", prev: "state", moved: "true", last: JSON.stringify(t.name), fairEnabled: `fairOn(${after})` }))}`;
  };

  /** Whether a fair event is possible in state `x0`: its guard allows it for some value the simulator tries. */
  const possible = (t: Transition) => t.guardParams.reduceRight((inner, name) => {
    const p = t.params.find((p) => p.name === name)!;
    return `${tried(p, t.name)}.exists(${name} => ${inner})`;
  }, t.guard ? call(t.guard, t.guardParams, "x0") : "true");
  // A law is tried on values picked for each parameter. One that takes the state is also evaluated on the states the
  // simulator reaches (below); if the spec gives no `<param>Values` for that parameter, that is the only way it is tried.
  const onReached = (l: Law) => evals.some((v) => v.name === l.name);
  const sampled = laws.filter((l) => !onReached(l) || l.params.every((p) => !stateType || shape(p.type) !== stateShape || samples.has(`${p.name}Values`)));
  const lawAction = (l: Law) =>
    `  action ${l.name} = ${braces(l.params, l.name, frame([], { lawsHold: `M::${l.name}(${l.params.map((p) => p.name).join(", ")})` }))}`;
  const evalAction = (v: Eval) => {
    const argument = (p: Eval["params"][number]) => p.from === "pick" ? p.name : p.from;
    const args = v.params.map(argument).join(", ");
    // A transition is only evaluated where its guard allows it, as it would be in use.
    const transition = transitions.find((t) => t.name === v.name && t.guard);
    // A law evaluated on a reachable state must hold there too: a false result breaks `inv`, as a picked one does.
    const result = `M::${v.name}(${args})`;
    const law: Record<string, string> = laws.some((l) => l.name === v.name) ? { lawsHold: result } : {};
    const guard = transition ? [call(transition.guard!, transition.guardParams.map((name) => argument(v.params.find((p) => p.name === name)!)), argument(v.params[0]))] : [];
    return `  action eval_${v.name} = ${braces(v.params.filter((p) => p.from === "pick"), v.name, frame(guard, { outcome: `Out_${v.name}(${result})`, ...law }))}`;
  };
  // An event of weight n is offered n times, so the simulator, which tries what it is offered in random order, picks it n times as often.
  const events = [...transitions.flatMap((t) => Array(weights.get(t.name) ?? 1).fill(t.name)), ...sampled.map((l) => l.name)];
  const any = (actions: string[]) => `any { ${(actions.length ? actions : [frame([], {})]).join(", ")} }`;
  const text = [
    `// GENERATED from ${source}. Drives the spec's transitions, laws and definitions for simulation.`,
    `module ${module}_run {`,
    `  import ${module} as M from "./${module}${opaques.length ? ".sim" : ""}"`,
    ...imports.map((i) => `  import ${i} as D_${i} from "./${i}"`),
    ...(evals.length ? [`  type Out = Nothing | ${evals.map((v) => `Out_${v.name}(${qType(v.result)})`).join(" | ")}`, `  var outcome: Out`] : []),
    ...(stateType ? [`  var state: ${qType(stateType)}`, `  var prev: ${qType(stateType)}`, `  var moved: bool`, `  var last: str`] : []),
    ...(output ? [`  var emitted: ${qType(output.out)}`] : []),
    ...(refines ? [`  var refined: bool`] : []),
    `  var lawsHold: bool`,
    ...(opaques.length ? [`  var settled: bool`] : []),
    ...(fair.size ? [`  var fairEnabled: Set[str]`,
      `  def fairOn(x0: ${qType(stateType)}): Set[str] = Set(${[...fair.keys()].map((e) => JSON.stringify(e)).join(", ")}).filter(x1 => or { ${transitions.filter((t) => fair.has(t.name)).map((t) => `x1 == ${JSON.stringify(t.name)} and ${possible(t)}`).join(", ")} })`] : []),
    `  action init = ${choose(frame([], { state: "M::initial", prev: "M::initial", moved: "false", last: '""', lawsHold: "true", outcome: "Nothing", emitted: "List()",
      ...(opaques.length ? { refined: "true", fairEnabled: "Set()", settled: "false", ...chosen } : start) }))}`,
    ...(opaques.length ? [`  action settle = ${frame(assumed, { ...start, settled: "true" })}`] : []),
    ...transitions.map(action),
    ...sampled.map(lawAction),
    ...evals.map(evalAction),
    `  action step = ${settled(any(events))}`,
    // Half events, half evaluations, so that definitions are evaluated on states well into a trace and not just near its start.
    `  action probe = ${settled(events.length && evals.length ? `any { ${any(events)}, ${any(evals.map((v) => `eval_${v.name}`))} }` : any([...events, ...evals.map((v) => `eval_${v.name}`)]))}`,
    `  val inv = ${opaques.length ? "not(settled) or " : ""}and { lawsHold, ${[...(refines ? ["refined"] : []), ...always.map((a) => `M::${a}(state)`), ...steps.map((r) => `(not(moved) or M::${r.name}(prev, ${r.via ? "last, " : ""}state${r.out ? ", emitted" : ""}))`), "true"].join(", ")} }`,
    // A witness search also stops at a broken rule, so that no run can step over one unreported.
    ...sometimes.map((w) => `  val never_${w} = inv and not(${opaques.length ? "settled and " : ""}M::${w}(state))`),
    // A guard's witnesses, for the `probe` step: breaking `never_allows_X` shows a reachable state and values for
    // which X allows its event, breaking `never_refuses_X` one for which it refuses it. Each reads the result the
    // last evaluation recorded, so a state costs the same however many values a parameter could take.
    ...transitions.flatMap((t) => (t.guard && evals.some((v) => v.name === t.guard) ? [
      `  val never_allows_${t.guard} = inv and match outcome { | Out_${t.guard}(r) => not(r) | _ => true }`,
      `  val never_refuses_${t.guard} = inv and match outcome { | Out_${t.guard}(r) => r | _ => true }`,
    ] : [])),
    `}`,
    ``,
  ].join("\n");
  // A sample set no parameter is named for is never used: most likely a typo for the parameter it was meant for.
  const forParams = new Set([...funs.flatMap((d) => sig(d).params.map((p) => `${p.name}Values`)), ...opaques.map((o) => `${o.name}Values`)]);
  for (const [set, { ref, line }] of samples)
    if (ref.startsWith("M::") && !forParams.has(set)) fail(`${set} (${source}${line ? `:${line}` : ""}): no parameter is named ${set.slice(0, -"Values".length)}, so the simulator never uses it; name it after the parameter it is for`);
  return { text, evals, uncompared };
}

/**
 * The spec's module as the harness of a spec with opaque functions imports it: each `const f: (A, B) => R` becomes a
 * table the harness chooses, and every definition may read it, so none is `pure`. Every line stays where it was.
 */
export const simulated = (qnt: string, opaques: Opaque[]): string => qnt.replace(/^(\s*)pure (def|val)\b/gm, "$1$2").replace(/^(\s*)const (\w+)\s*:\s*\((.*)\)\s*=>\s*(.*)$/gm, (line, indent, name, args, result) => {
  const o = opaques.find((o) => o.name === name);
  if (!o) return line;
  const ps = o.params.map((p) => p.name);
  const key = ps.length === 1 ? ps[0] : `(${ps.join(", ")})`;
  return `${indent}var opaque_${name}: ${ps.length === 1 ? args : `(${args})`} -> ${result} var opaque_${name}_else: ${result} `
    + `def ${name}(${ps.join(", ")}) = if (opaque_${name}.keys().contains(${key})) opaque_${name}.get(${key}) else opaque_${name}_else`;
});
