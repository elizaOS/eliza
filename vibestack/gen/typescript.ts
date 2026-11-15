// The TypeScript module for one spec: its types, its definitions with their proof obligations, and, for a state
// machine, the event type and the functions that apply and admit events.
import { SENDER, type Opaque, type Param, type Roles, type Transition } from "./classify.ts";
import type { Printer } from "./print.ts";
import type { Json, Types } from "./types.ts";

/** The names a module defines beside the spec's, and the locals of what it defines (TAKEN in gen.ts). */
export const EMITTED = ["Event", "opaque", "inv", "enabled", "step", "parseEvent", "parseState", "parseSender", "initialHolds", "current", "event", "raw"];
/** Prefixes reserved for the helpers a module may carry for itself, each named `<helper>_<module>`, and for local bindings. */
export const HELPERS = ["quotient", "remainder", "exact", "equal", "nth", "get", "lookup\\d+", "snapshot", "local"];

export interface Source {
  /** The line that opens the file, and one import line per spec this one imports. */
  header: string[];
  typedefs: Json[];
  vals: Json[];
  funs: Json[];
  sig: (d: Json) => { params: Param[]; result: Json };
  typeOf: (id: number) => Json;
  /** The doc comment that ties a definition to its rule in the spec; empty if it has none. */
  doc: (def: string) => string;
  /** One of the module's own top-level names, as this rendering spells it. */
  local: (name: string) => string;
  /** The spec's file, for messages. */
  source: string;
}

export function typescript({ header, typedefs, vals, funs, sig, typeOf, doc, local: L, source }: Source, roles: Roles, types: Types, print: Printer, helper: (which: string) => string): string {
  const { tsType, declaration, validators, copy } = types;
  const { transitions, always, steps, laws, opaques, sender, output, refines } = roles;
  const state = roles.stateType && tsType(roles.stateType);
  // Where some transition has output, `step` returns it beside the state, and a transition without output outputs nothing.
  const nothing = output && `([] as ${tsType(output.out)})`;
  const outputs = (s: string) => (output ? `{ state: ${s}, out: ${nothing} }` : s);
  // A refining spec's step leaves the abstract state as it was, or takes the abstract step of its name (SPEC.md,
  // "Refinement"; gen/harness.ts, `refined`).
  const abstract = (n: string) => `${refines!.of.module}_${n}`;
  const refined = (t: Transition, before: string, after: string) => {
    const [from, to] = [before, after].map((s) => `${L(refines!.fn)}(${s})`);
    const u = refines!.of.transitions.find((u) => u.name === t.name);
    const guard = u?.guard ? `${abstract(u.guard)}(${[from, ...u.guardParams].join(", ")}) && ` : "";
    return `${to} === ${from}${u ? ` || (${guard}${to} === ${abstract(u.name)}(${[from, ...u.params.map((p) => p.name)].join(", ")})${u.emits ? ".state" : ""})` : ""}`;
  };
  // Who sent an event is never part of it: the program passes it to `enabled` and `step` from what it trusts.
  const carried = (t: Transition) => t.params.filter((p) => p.name !== SENDER);
  const by = sender ? `, ${SENDER}: ${tsType(sender)}` : "";
  const out: string[] = [...header, ``, ...typedefs.map((d) => doc(d.name) + declaration(d))];
  if (state) out.push(
    ``,
    `/** One variant per transition in the spec${sender ? `, without \`${SENDER}\`: who sent it is passed beside it` : ""}. */`,
    `export type ${L("Event")} =`,
    ...transitions.map((t) => `  | { type: ${JSON.stringify(t.name)}${carried(t).map((p) => `; ${p.name}: ${tsType(p.type)}`).join("")} }`).map((l, i, all) => (i === all.length - 1 ? l + ";" : l)),
  );
  // The program gives each opaque function, and replay the table a trace chose (simulate.ts, `standIn`). The proof
  // knows one only by its type and the laws assumed of it: LemmaScript declares an extern without its body.
  const signature = (o: Opaque, arrow = ":") => `(${o.params.map((p) => `${p.name}: ${tsType(p.type)}`).join(", ")})${arrow} ${tsType(o.result)}`;
  if (opaques.length) out.push(
    ``,
    `/** The spec's opaque functions, which the program sets before it calls anything that uses them. */`,
    `//@ skip`,
    `export const ${L("opaque")}: { ${opaques.map((o) => `${o.name}?: ${signature(o, " =>")}`).join("; ")} } = {};`,
  );
  for (const o of opaques) out.push(
    ``,
    `${doc(o.name)}//@ extern`,
    `//@ pure`,
    `export function ${L(o.name)}${signature(o)} {`,
    `  const given = ${L("opaque")}.${o.name};`,
    `  if (!given) throw new Error(${JSON.stringify(`${o.name} is opaque in ${source}: set opaque.${o.name} first`)});`,
    `  return given(${o.params.map((p) => p.name).join(", ")});`,
    `}`,
  );
  out.push(``, ...vals.map((d) => `${doc(d.name)}export const ${L(d.name)}: ${tsType(typeOf(d.id))} = ${print.ex(d.expr)};`));
  if (state) out.push(
    ``,
    `/** Every \`always\` rule at once. Holds initially and after every transition. */`,
    `//@ pure`,
    `export function ${L("inv")}(current: ${state}): boolean {`,
    `  return ${always.length ? always.map((a) => `${L(a)}(current)`).join(" && ") : "true"};`,
    `}`,
  );
  for (const d of funs) {
    const { params, result } = sig(d);
    const t = transitions.find((t) => t.name === d.name);
    // One `ensures` per rule, so a failed proof names the rule that the transition breaks. The transition has no
    // precondition: its guarantees are conditional instead, so that a guard may itself look at the transition's result.
    const given = t && `(${L("inv")}(${params[0].name})${t.guard ? ` && ${L(t.guard)}(${[params[0].name, ...t.guardParams].join(", ")})` : ""}) ==> `;
    const after = t?.emits ? "\\result.state" : "\\result";
    const contract = t ? [
      ...(refines ? [`  //@ ensures ${given}(${refined(t, params[0].name, after)})`] : []),
      ...always.map((a) => `  //@ ensures ${given}${L(a)}(${after})`),
      ...steps.map((r) => `  //@ ensures ${given}${L(r.name)}(${[params[0].name, ...(r.via ? [JSON.stringify(t.name)] : []), after, ...(r.out ? [t.emits ? "\\result.out" : "[]"] : [])].join(", ")})`),
    ] : laws.some((l) => l.name === d.name) ? [`  //@ ensures \\result === true`] : [];
    out.push(
      ``,
      `${doc(d.name)}//@ pure`,
      `export function ${L(d.name)}(${params.map((p) => `${p.name}: ${tsType(p.type)}`).join(", ")}): ${tsType(result)} {`,
      ...contract,
      ...print.body(d.expr.expr, d.expr.params).map((l) => `  ${l}`),
      `}`,
    );
  }
  const call = (fn: string, params: string[]) => `${L(fn)}(${["current", ...params.map((p) => (p === SENDER ? p : `event.${p}`))].join(", ")})`;
  const admits = (t: Transition) => call(t.guard!, t.guardParams);
  const applies = (t: Transition) => call(t.name, t.params.map((p) => p.name));
  const when = (t: Transition) => `event.type === ${JSON.stringify(t.name)}`;
  // A copy through JSON drops what JSON cannot hold; a value it cannot copy at all is not one the program accepts.
  const cloned = [`  let raw: any;`, `  try {`, `    raw = JSON.parse(JSON.stringify(x));`, `  } catch {`, `    return undefined;`, `  }`];
  const parsed = (t: Transition) => `{ ${[`type: ${JSON.stringify(t.name)}`, ...carried(t).map((p) => `${p.name}: ${copy(`raw.${p.name}`, p.type)}`)].join(", ")} }`;
  // An event may carry more than its type names, which `parsed` drops; a state or a sender is exactly its type.
  const carries = validators();
  const events = transitions.map((t) => `  if (raw.type === ${JSON.stringify(t.name)}${carried(t).map((p) => ` && ${carries.test(`raw.${p.name}`, p.type)}`).join("")}) return ${parsed(t)};`);
  const whole = (t: Json) => {
    const exactly = validators(true);
    const is = `  if (!(${exactly.test("raw", t)})) return undefined;`;
    return [...exactly.lines(), is];
  };
  if (state) out.push(
    ``,
    `/** Do the rules allow this event${sender ? `, from this sender,` : ""} in this state? */`,
    `//@ pure`,
    `export function ${L("enabled")}(current: ${state}, event: ${L("Event")}${by}): boolean {`,
    ...transitions.map((t) => `  if (${when(t)}) return ${t.guard ? admits(t) : "true"};`),
    `  return false;`,
    `}`,
    ``,
    `/** Apply an event${sender ? ` from \`${SENDER}\`, whom the program knows from what it trusts, never from the event` : ""}. An event the rules do not allow leaves the state unchanged${output ? "; the result holds the state and what the event output" : ""}. */`,
    `//@ pure`,
    `export function ${L("step")}(current: ${state}, event: ${L("Event")}${by}): ${output ? tsType(output.type) : state} {`,
    `  //@ requires ${L("inv")}(current)`,
    `  //@ ensures ${L("inv")}(\\result${output ? ".state" : ""})`,
    ...transitions.map((t) => `  if (${when(t)}${t.guard ? ` && ${admits(t)}` : ""}) return ${t.emits ? applies(t) : outputs(applies(t))};`),
    `  return ${outputs("current")};`,
    `}`,
    ``,
    `/**`,
    ` * Turn an untrusted value into an event, or undefined if it is not one. Use it wherever events enter the program:`,
    ` * the proofs assume whole numbers and plain data, and this is what makes that true. The result is a fresh copy`,
    ` * with exactly the fields the event has, so nothing the caller keeps can change it afterwards.`,
    ` */`,
    `//@ skip`,
    `export function ${L("parseEvent")}(x: unknown): ${L("Event")} | undefined {`,
    ...cloned,
    ...carries.lines(),
    `  if (typeof raw !== "object" || raw === null) return undefined;`,
    ...events,
    `  return undefined;`,
    `}`,
    ``,
    `/**`,
    ` * Turn an untrusted value, such as a state loaded from storage, into a state, or undefined if it is not one. It must`,
    ` * have exactly the state's shape (no other fields, whole numbers that are safe integers, sets that hold nothing`,
    ` * twice, maps as records whose keys carry the "$" every key carries here) and satisfy every \`always\` rule. The`,
    ` * result is a fresh copy, so nothing the caller keeps can change it afterwards.`,
    ` */`,
    `//@ skip`,
    `export function ${L("parseState")}(x: unknown): ${state} | undefined {`,
    ...cloned,
    ...whole(roles.stateType),
    `  const parsed: ${state} = ${copy("raw", roles.stateType)};`,
    `  return ${L("inv")}(parsed) ? parsed : undefined;`,
    `}`,
    ``,
    `/** Proof obligation: the initial state satisfies every \`always\` rule. */`,
    `export function ${L("initialHolds")}(): ${state} {`,
    `  //@ ensures ${L("inv")}(\\result)`,
    ...(refines ? [`  //@ ensures ${L(refines.fn)}(\\result) === ${abstract("initial")}`] : []),
    `  return ${L("initial")};`,
    `}`,
  );
  if (sender) out.push(
    ``,
    `/** Validate and copy the trusted sender supplied beside an event. */`,
    `//@ skip`,
    `export function ${L("parseSender")}(x: unknown): ${tsType(sender)} | undefined {`,
    ...cloned,
    ...whole(sender),
    `  return ${copy("raw", sender)};`,
    `}`,
  );
  // The helpers come last: which are needed is known only once every definition has been printed.
  print.lookups.forEach(({ map, key, of, stored }, i) => out.push(
    ``,
    `/** What a map holds for a key, or \`otherwise\` if it holds nothing for it. */`,
    `//@ pure`,
    `export function ${helper(`lookup${i}`)}(m: ${map}, k: ${key}, otherwise: ${of}): ${of} {`,
    `  const key = ${stored};`,
    `  return key in m ? m[key] : otherwise;`,
    `}`,
  ));
  // Only in the code Node runs, which checks what the proof takes as given (Scope.proof in print.ts).
  if (print.helpers.has("exact")) out.push(
    ``,
    `/** An integer result, which must be exact: past 2^53 a number is rounded, where Quint's and the proof's integers are not. */`,
    `export function ${helper("exact")}(n: number): number {`,
    `  if (!Number.isSafeInteger(n)) throw new RangeError(\`an integer result is \${n}, beyond 2^53, where TypeScript cannot hold it exactly\`);`,
    `  return n;`,
    `}`,
  );
  if (print.helpers.has("equal")) out.push(
    ``,
    `/** Equality by structure, as Quint and the proof compare records, lists, maps and variants (none holds a set). */`,
    `export function ${helper("equal")}(a: unknown, b: unknown): boolean {`,
    `  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;`,
    `  const keys = Object.keys(a);`,
    `  return Array.isArray(a) === Array.isArray(b) && keys.length === Object.keys(b).length`,
    `    && keys.every((k) => Object.hasOwn(b, k) && ${helper("equal")}((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));`,
    `}`,
  );
  if (print.helpers.has("nth")) out.push(
    ``,
    `/** An element of a list, which must hold it. */`,
    `export function ${helper("nth")}<T>(xs: T[], i: number): T {`,
    `  if (!(0 <= i && i < xs.length)) throw new RangeError(\`a list of \${xs.length} has no element \${i}\`);`,
    `  return xs[i];`,
    `}`,
  );
  if (print.helpers.has("get")) out.push(
    ``,
    `/** What a map holds for a key, which it must hold. */`,
    `export function ${helper("get")}<K extends string | number, T>(m: Record<K, T>, key: K): T {`,
    `  if (!(key in m)) throw new RangeError(\`a map holds nothing for \${key}\`);`,
    `  return m[key];`,
    `}`,
  );
  if (print.helpers.has("quotient")) out.push(
    ``,
    `/** Whole-number division as Quint does it: towards zero. */`,
    `//@ pure`,
    `export function ${helper("quotient")}(a: number, b: number): number {`,
    `  //@ requires b !== 0`,
    ...(print.proof ? [] : [`  if (b === 0) throw new RangeError(\`\${a} cannot be divided by zero\`);`]),
    `  return (a < 0 === b < 0 ? 1 : -1) * Math.floor(Math.abs(a) / Math.abs(b)) + 0;`,
    `}`,
  );
  if (print.helpers.has("remainder")) out.push(
    ``,
    `/** The remainder of that division; it has the sign of the dividend. */`,
    `//@ pure`,
    `export function ${helper("remainder")}(a: number, b: number): number {`,
    `  //@ requires b !== 0`,
    `  return a - b * ${helper("quotient")}(a, b);`,
    `}`,
  );
  return [...out, ``].join("\n");
}
