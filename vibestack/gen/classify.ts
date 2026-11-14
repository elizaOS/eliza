// What each definition of a spec is, read off its name and its signature.
import { fail, type Json, type Types } from "./types.ts";

export interface Param { name: string; type: Json }
/** `guardParams`: the transition's parameters its guard takes, by name, after the state; `emits` if it returns `{ state, out }`. */
export interface Transition { name: string; params: Param[]; guard: string | undefined; guardParams: string[]; emits: boolean }
export interface Law { name: string; params: Param[] }
/** A function declared without a body (`const f: (A) => R`), its parameters named p0, p1, …, and the laws assumed of it. */
export interface Opaque { name: string; params: Param[]; result: Json; laws: Law[] }
/** A `step` rule; `via` if it also takes the name of the transition between the two states, `out` if what it output. */
interface StepRule { name: string; via: boolean; out: boolean }
export interface Roles {
  /** The type of `initial`; undefined for a library, which has definitions and laws but no state machine. */
  stateType: Json | undefined;
  transitions: Transition[];
  always: string[];
  sometimes: string[];
  steps: StepRule[];
  /** `leadsTo` rules: from every reachable state, every fair run reaches a state the rule relates it to. */
  leadsTo: string[];
  /** Laws that are proved; those assumed of an opaque function are in `opaques`. */
  laws: Law[];
  opaques: Opaque[];
  /** The type of the transitions' `by` parameter: who sent the event, which the program supplies and no event carries. */
  sender: Json | undefined;
  /** What a transition with output returns, the record `{ state, out }`, and the type of `out`, a list of effects. */
  output: { type: Json; out: Json } | undefined;
  refines: Refinement | undefined;
}

/**
 * A machine this spec imports under a name, as this spec spells its types. `refines<Alias>(state)` maps the state onto
 * it; each transition then corresponds to the machine's transition of the same name, or to none (SPEC.md, "Refinement").
 */
export interface ImportedMachine { alias: string; module: string; stateType: Json; transitions: Transition[] }
export interface Refinement { fn: string; of: ImportedMachine }

/** The parameter that names who sent an event (SPEC.md, "What goes in the Quint blocks"). */
export const SENDER = "by";
/** The parameter of a `step` rule that names the transition taken (SPEC.md, "What goes in the Quint blocks"). */
export const VIA = "via";
/** The last parameter of a `step` rule that sees what the transition output (SPEC.md, "What goes in the Quint blocks"). */
const OUT = "out";
/** The prefixes that make a definition a rule; all but `law` and `refines` are rules about states. */
const STATE_ROLES = ["always", "sometimes", "step", "leadsTo"];
export const ROLES = [...STATE_ROLES, "law", "refines"];

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * `funs` are the spec's `pure def`s in the order it gives them; `sig` gives a definition's parameters and result.
 * The convention: `initial` is the state; a definition from the state to the state is a transition and `can<Name>`
 * its guard, which takes the state and any of the transition's parameters by name. A transition may return the state
 * beside what it outputs, as a record `{ state, out: List[…] }`. `alwaysX(state)`, `stepX(before, [via,] after, [out])`
 * `leadsToX(from, to)` and `sometimesX(state)` are rules; `lawX(...)` is a law. `refines<Alias>(state)` maps the state
 * onto a machine in `machines`, those the spec imports under a name.
 */
export function classify(funs: Json[], stateType: Json | undefined, sig: (d: Json) => { params: Param[]; result: Json }, { shape, resolve, fields, holdsSet }: Types, machines: ImportedMachine[]): Roles {
  const stateShape = stateType && shape(stateType);
  const isState = (t: Json) => shape(t) === stateShape;
  const onState = (d: Json, at = 0) => sig(d).params.length > at && isState(sig(d).params[at].type);
  const isBool = (d: Json) => sig(d).result.kind === "bool";
  /** The `{ state, out }` a transition with output returns, or undefined if `t` is not that. */
  const outputOf = (t: Json): Roles["output"] => {
    const r = resolve(t);
    const [state, out] = ["state", "out"].map((n) => (r.kind === "rec" ? fields(r).find((f) => f.fieldName === n)?.fieldType : undefined));
    return state && out && fields(r).length === 2 && isState(state) && resolve(out).kind === "list" ? { type: t, out } : undefined;
  };
  // A rule whose name is nearly right would otherwise be an unchecked helper.
  for (const d of funs) {
    const role = ROLES.find((r) => d.name.toLowerCase().startsWith(r.toLowerCase()));
    if (role && !new RegExp(`^${role}[A-Z]`).test(d.name) && d.name.toLowerCase() !== role.toLowerCase()) fail(`${d.name}: write \`${role}\` rules as ${role}Something`);
    if (/^Can[A-Z]/.test(d.name)) fail(`${d.name}: write guards as can${d.name.slice(3)}`);
  }
  const named = (prefix: string) => funs.filter((d) => new RegExp(`^${prefix}[A-Z]`).test(d.name));
  const stateRole = `(${STATE_ROLES.join("|")})`;
  if (!stateType) for (const d of named(stateRole)) fail(`${d.name}: \`${d.name.match(new RegExp(`^${stateRole}`))![0]}\` rules need a state, so the spec must define \`pure val initial\``);
  const stateRule = (prefix: string): string[] => named(prefix).map((d) =>
    isBool(d) && sig(d).params.length === 1 && onState(d) ? d.name : fail(`${d.name}: a \`${prefix}\` rule takes the state and returns bool`));
  const always = stateRule("always");
  const sometimes = stateRule("sometimes");
  const leadsTo = named("leadsTo").map((d) =>
    isBool(d) && sig(d).params.length === 2 && onState(d, 0) && onState(d, 1) ? d.name : fail(`${d.name}: a \`leadsTo\` rule takes a state and a later state, and returns bool`));
  const laws: Law[] = named("law").map((d) => (isBool(d) ? { name: d.name, params: sig(d).params } : fail(`${d.name}: a law returns bool`)));
  const rules = new Set([...always, ...sometimes, ...named("step").map((d) => d.name), ...leadsTo, ...laws.map((l) => l.name), ...named("refines").map((d) => d.name)]);
  const transitions: Transition[] = !stateType ? [] : funs
    .filter((d) => !rules.has(d.name) && onState(d) && (isState(sig(d).result) || outputOf(sig(d).result)))
    .map((d) => {
      const params = sig(d).params.slice(1);
      const guard = funs.find((g) => g.name === `can${cap(d.name)}`);
      if (guard && !onState(guard)) fail(`${guard.name} must take the state first, as ${d.name} does`);
      if (guard && !isBool(guard)) fail(`${guard.name}: a guard returns bool`);
      // A guard takes the state, then any of its transition's parameters, by the same names and types.
      const guardParams = guard ? sig(guard).params.slice(1).map((g) => {
        const p = params.find((p) => p.name === g.name);
        return p && shape(p.type) === shape(g.type) ? g.name : fail(`${guard.name}: \`${g.name}\` must be a parameter of ${d.name}, of the same type`);
      }) : [];
      return { name: d.name, params, guard: guard?.name, guardParams, emits: !isState(sig(d).result) };
    });
  // Every transition with output outputs the same kind of effect, so that `step` can return it.
  const outputs = funs.filter((d) => transitions.some((t) => t.name === d.name && t.emits)).map((d) => outputOf(sig(d).result)!);
  if (outputs.some((o) => shape(o.type) !== shape(outputs[0].type))) fail("every transition with output returns the same `{ state, out }` type, so that `step` can return what any of them outputs");
  const output = outputs[0];
  const steps: StepRule[] = named("step").map((d) => {
    const all = sig(d).params;
    const out = all.at(-1)?.name === OUT;
    const ps = out ? all.slice(0, -1) : all;
    if (out && !(output && shape(all.at(-1)!.type) === shape(output.out))) fail(`${d.name}: \`${OUT}\` is what the transition output, ${output ? "so it has the type of `out` in what transitions return" : "but no transition returns `{ state, out }`"}`);
    const via = ps.length === 3 && ps[1].name === VIA && resolve(ps[1].type).kind === "str";
    const ok = isBool(d) && ps.length > 1 && isState(ps[0].type) && isState(ps.at(-1)!.type) && (ps.length === 2 || via);
    return ok ? { name: d.name, via, out } : fail(`${d.name}: a \`step\` rule takes the state before, optionally \`${VIA}: str\` (the transition taken), the state after, optionally \`${OUT}\` (what the transition output), and returns bool`);
  });
  // Without a transition there are no events, and the Event type would be empty, which TypeScript cannot declare.
  if (stateType && !transitions.length) fail("the spec defines `initial` but no transition: add a `pure def` from the state to the state, or drop `initial` to make it a library");
  // In a library, `withdraw` and `canWithdraw` are a component's functions for a machine elsewhere to build on.
  for (const g of stateType ? funs.filter((d) => /^can[A-Z]/.test(d.name)) : [])
    if (!transitions.some((t) => t.guard === g.name)) fail(`${g.name}: no transition named ${g.name[3].toLowerCase()}${g.name.slice(4)}`);
  const senders = transitions.flatMap((t) => t.params.filter((p) => p.name === SENDER));
  if (senders.some((p) => shape(p.type) !== shape(senders[0].type))) fail(`\`${SENDER}\` names who sent an event, so every transition that takes it takes the same type`);
  return { stateType, transitions, always, sometimes, steps, leadsTo, laws, opaques: [], sender: senders[0]?.type, output, refines: refinement() };

  function refinement(): Refinement | undefined {
    const [d, twice] = named("refines");
    if (!d) return undefined;
    if (twice) fail(`${twice.name}: a spec refines one machine, and ${d.name} already names it`);
    const alias = d.name.slice("refines".length);
    const of = machines.find((m) => m.alias === alias) ?? fail(`${d.name}: \`refines${alias}\` maps the state onto the machine imported as ${alias} (\`import <spec> as ${alias} from "./<spec>"\`), and no machine is imported as ${alias}`);
    if (!stateType || sig(d).params.length !== 1 || !onState(d) || shape(sig(d).result) !== shape(of.stateType)) fail(`${d.name}: takes the state and returns the state of ${alias}`);
    // Abstract states are compared with ==, which the proof would do in order for a set (gen/print.ts, `comparable`).
    if (holdsSet(of.stateType)) fail(`${d.name}: the state of ${alias} holds a set, which a refinement cannot compare yet`);
    // A transition corresponds to the abstract one of its name, which takes its parameters by name, as a guard does.
    for (const t of transitions) for (const p of of.transitions.find((u) => u.name === t.name)?.params ?? [])
      if (!t.params.some((q) => q.name === p.name && shape(q.type) === shape(p.type))) fail(`${t.name} corresponds to ${alias}::${t.name}, which takes \`${p.name}\`: give ${t.name} a parameter \`${p.name}\` of the same type, or another name if it is not that step of ${alias}`);
    return { fn: d.name, of };
  }
}
