// Quint expressions as TypeScript. Anything outside the supported subset throws with the name of the construct.
import { fail, typeOfIn, type Json, type Types } from "./types.ts";

// Operator precedence, loosest first. Mixed `&&`/`||` is always parenthesised.
const [ARROW, TERNARY, OR, AND, EQ, COMPARE, ADD, MULTIPLY, UNARY, ATOM] = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8];
const BINARY: Record<string, [string, number]> = {
  iadd: ["+", ADD], isub: ["-", ADD], imul: ["*", MULTIPLY],
  ilt: ["<", COMPARE], ilte: ["<=", COMPARE], igt: [">", COMPARE], igte: [">=", COMPARE],
  eq: ["===", EQ], neq: ["!==", EQ],
};
/** Quint's set operations, as array expressions that keep the "no value twice" property. */
type SetArgs = { a: string; b: string; el: string; out: string; not: () => string };
const SET_OPS: Record<string, (x: SetArgs) => string> = {
  contains: ({ a, b }) => `${a}.includes(${b})`,
  in: ({ a, b }) => `${a}.includes(${b})`,
  size: ({ a }) => `${a}.length`,
  union: ({ a, b, el }) => `${a}.concat(${b}.filter((set_x: ${el}) => !${a}.includes(set_x)))`, // not a literal: see `joined`
  intersect: ({ a, b, el }) => `${a}.filter((set_x: ${el}) => ${b}.includes(set_x))`,
  exclude: ({ a, b, el }) => `${a}.filter((set_x: ${el}) => !${b}.includes(set_x))`,
  subseteq: ({ a, b, el }) => `!${a}.some((set_x: ${el}) => !${b}.includes(set_x))`,
  filter: ({ a, b }) => `${a}.filter(${b})`,
  forall: ({ a, not }) => `!${a}.some(${not()})`, // as `every` (LIST_HELPERS)
  exists: ({ a, b }) => `${a}.some(${b})`,
  map: ({ a, b, out }) => `${a}.map(${b}).reduce((set_acc: ${out}[], set_x: ${out}) => set_acc.includes(set_x) ? set_acc : [...set_acc, set_x], ([] as ${out}[]))`,
};

/** Every Quint operator a spec may use, beside the list helpers and builtins below: `print` refuses any other. */
export const OPERATORS = new Set([
  ...Object.keys(BINARY), ...Object.keys(SET_OPS), "Set", "iuminus", "idiv", "imod", "not", "and", "or", "implies", "iff", "ite",
  "Map", "put", "set", "get", "keys", "field", "Rec", "with", "matchVariant",
  "List", "append", "concat", "length", "nth", "head", "tail", "select", "foldl",
]);

/** What the printer needs to know about the module an expression is in. */
export interface Scope {
  types: Types;
  /** The type the checker inferred for an expression or parameter, if it recorded one. */
  inferred: (id: number) => Json | undefined;
  /** A reference to a definition, as TypeScript spells it. */
  ref: (name: string) => string;
  /** The name of a helper function the module carries for itself (HELPERS in typescript.ts). */
  helper: (which: string) => string;
  /** Checks that a name the spec binds survives translation unchanged. */
  bind: (name: string) => string;
  variants: Set<string>;
  definitions: Set<string>;
  /** Sample sets and `weight_`, `fair_` and `within_` settings, which never reach TypeScript (gen.ts). */
  simulatorOnly: Set<string>;
  /**
   * Whether the code is for the prover rather than for Node. Node's code checks at run time two things the proof takes
   * as given: that integer arithmetic is exact (a number past 2^53 is rounded, where Quint's and Dafny's integers are
   * not, so such a result throws a RangeError), that a divisor is not zero and a list or map holds what is read from
   * it (a RangeError too), and that `==` on records, lists and variants compares their structure (which JavaScript's
   * `===` does not, but Dafny's `==` does). Otherwise the two are the same text.
   */
  proof: boolean;
}

/**
 * `every`, `some`, `includes` and `listMap` are not Quint: the tangler expands them into Quint's built-in `foldl`
 * (expandListHelpers in parse.ts), marking the accumulator `std_<helper>_<n>` so that `print` writes `method`, the
 * native array method, or `includes`. They cannot be Quint definitions that take a lambda, because Quint evaluates such
 * a definition wrongly when it is used inside its own argument, as in `tasks.some(t => t.parents.some(...))`.
 * `every`, like a set's `forall` and `subseteq`, is printed as `!xs.some(x => !p)`: LemmaScript gives `some` and
 * `includes` to Dafny as quantifiers over the members, and `every` as `Std.Collections.Seq.All`, a function over
 * indexes that a proof has to unfold before it meets either.
 */
export const LIST_HELPERS: Record<string, { init: string; step: (acc: string, body: string) => string; method?: string }> = {
  every: { init: "true", step: (acc, body) => `${acc} and (${body})` },
  some: { init: "false", step: (acc, body) => `${acc} or (${body})`, method: "some" },
  listMap: { init: "List()", step: (acc, body) => `${acc}.append(${body})`, method: "map" },
  includes: { init: "false", step: (acc, body) => `${acc} or ${body}` },
};
const LIST_HELPER = new RegExp(`^std_(${Object.keys(LIST_HELPERS).join("|")})_`);

/**
 * `m.getOr(k, d)`, `xs.nthOr(i, d)` and `xs.removeAt(i)` are not Quint either. The tangler renames each call to
 * `std_<name>_<module>` and defines that, in Quint, below the module's last line (expandBuiltins in parse.ts), so that a
 * module and one it imports never define the same name; `print` writes the TypeScript the prover follows.
 */
export const BUILTINS: Record<string, string> = {
  getOr: "(std_m: a -> b, std_k: a, std_d: b): b = if (std_m.keys().contains(std_k)) std_m.get(std_k) else std_d",
  nthOr: "(std_xs: List[a], std_i: int, std_d: a): a = if (0 <= std_i and std_i < std_xs.length()) std_xs.nth(std_i) else std_d",
  removeAt: "(std_xs: List[a], std_i: int): List[a] = if (0 <= std_i and std_i < std_xs.length()) std_xs.slice(0, std_i).concat(std_xs.slice(std_i + 1, std_xs.length())) else std_xs",
};
export const BUILTIN = new RegExp(`^std_(${Object.keys(BUILTINS).join("|")})_`);

/** The set and the value of a membership test, whichever way round it is written. */
const members = (op: string, a: Json[]): [Json, Json] => (op === "in" ? [a[1], a[0]] : [a[0], a[1]]);

/** `-1` arrives as `iuminus(1)`: the literal it is, or undefined. */
const negative = (e: Json): Json | undefined => (e.kind === "app" && e.opcode === "iuminus" && e.args[0].kind === "int" ? { kind: "int", value: -e.args[0].value } : undefined);

/** Puts a binding back as it was before an inner scope shadowed it. */
const restore = <V>(m: Map<string, V>, k: string, v: V | undefined) => (v === undefined ? m.delete(k) : m.set(k, v));

export function printer({ types, inferred, ref, helper, bind, variants, definitions, simulatorOnly, proof }: Scope) {
  const { resolve, tagged, isScalar, setElem, keyOf, storedKey, holdsSet, named, ownerOf, typeName, tsType } = types;
  const typeOf = typeOfIn(inferred);
  const forSimulator = (n: string): never => fail(`\`${n}\` is for the simulator only (a sample set or a weight_, fair_ or within_ setting) and cannot be used in a definition`);
  /** Which helpers the printed code needs (see typescript.ts), and the types of the maps it looks things up in. */
  const helpers = new Set<string>();
  const lookups: { map: string; key: string; of: string; stored: string }[] = [];
  /** Names that stand for something else while a `match` arm is printed: the arm's binder is the matched value. */
  const renamed = new Map<string, string>();
  const matchedAs = new Map<string, string>(); // binder -> the variant its arm matched
  let locals = new Map<string, string>();
  let localId = 0;
  let nesting = 0;
  const reference = (name: string) => locals.get(name) ?? ref(name);
  const scoped = <T>(names: string[], render: () => T): T => {
    const outer = locals;
    locals = new Map([...outer, ...names.map((name) => [name, name] as const)]);
    try { return render(); } finally { locals = outer; }
  };

  /** `ex(e, min)` prints `e`, parenthesised only if it binds looser than `min`. */
  const ex = (e: Json, min = ARROW): string => {
    nesting++;
    const [text, prec] = print(e);
    nesting--;
    return prec < min ? `(${text})` : text;
  };
  const flat = (e: Json, op: string): Json[] => (e.kind === "app" && e.opcode === op ? e.args.flatMap((x: Json) => flat(x, op)) : [e]);
  const tag = (variant: string) => JSON.stringify(variant.split("::").pop());
  /** A key of the map `m` as the generated object stores it (keyOf in types.ts). */
  const mapKey = (m: Json, k: Json) => storedKey(typeOf(m.id), ex(k, ADD + 1));
  /** The map `m`, of type `t`, with `value` under `key`. */
  const put = (m: string, t: Json, key: string, value: string) => `({ ...${m}, [${key}]: ${value} } as ${tsType(t)})`;
  /**
   * What the map `m` holds for the key `k`, or `d`. It goes through a helper in which the key is one name, which is the
   * form both TypeScript and the prover can see is safe.
   */
  const lookup = (m: Json, k: Json, d: Json): [string, number] => {
    const t = resolve(typeOf(m.id));
    const entry = { map: tsType(t), key: tsType(keyOf(t)), of: tsType(t.res), stored: storedKey(t, "k") };
    const i = lookups.findIndex((l) => l.map === entry.map);
    return [`${helper(`lookup${i < 0 ? lookups.push(entry) - 1 : i}`)}(${ex(m, TERNARY)}, ${ex(k, TERNARY)}, ${ex(d, TERNARY)})`, ATOM];
  };
  /** An integer result of arithmetic, which Node's code checks is exact (Scope.proof). */
  const exact = (text: string, prec: number): [string, number] => (proof ? [text, prec] : [`${helper("exact")}(${(helpers.add("exact"), text)})`, ATOM]);
  /** A read that is undefined outside the list or map, where Node's code throws a RangeError (Scope.proof). */
  const partial = (which: "nth" | "get", from: string, at: string): [string, number] =>
    [proof ? `${from}[${at}]` : `${helper(which)}(${(helpers.add(which), from)}, ${at})`, ATOM];
  /** Records, lists and variants compare by structure (Scope.proof); a set inside one would compare in order in the proof. */
  const comparable = (e: Json) => !holdsSet(typeOf(e.id)) || fail("== and includes on a value that holds a set are not supported: in the proof a set is a sequence, compared in order; compare sets with subseteq both ways");
  const equal = (a: string, b: string) => `${helper("equal")}(${(helpers.add("equal"), a)}, ${b})`;
  /** Inside another expression a record literal has no declared type to check against, so it states its own. */
  const typed = (text: string, e: Json): string => {
    const d = nesting > 1 ? named(typeOf(e.id), "rec") : undefined;
    return d ? `(${text} as ${typeName(d)})` : text;
  };
  /** `name: value` for each pair of a record literal's arguments. */
  const pairs = (args: Json[]) => args.flatMap((_, i) => (i % 2 ? [] : [`${args[i].value}: ${ex(args[i + 1], TERNARY)}`]));
  /** `{ ...x, a: 1, b: 2 }` arrives as nested updates; this is what is updated, and the updates in order. */
  const unroll = (e: Json): { base: Json; updates: string[] } => {
    const updates: string[] = [];
    for (; e.kind === "app" && e.opcode === "with"; e = e.args[0]) updates.unshift(`${e.args[1].value}: ${ex(e.args[2], TERNARY)}`);
    return { base: e, updates };
  };
  /**
   * `a.append(x).append(y).concat(b)` as one call, `a.concat([x, y], b)`, rather than calls nested in calls. Not an
   * array literal: LemmaScript knows what `concat` returns, but not what a literal is, if a list method is called on it.
   */
  const parts = (e: Json): (string | string[])[] =>
    e.kind === "app" && e.opcode === "append" ? [...parts(e.args[0]), [ex(e.args[1], TERNARY)]]
    : e.kind === "app" && e.opcode === "concat" ? [...parts(e.args[0]), ...parts(e.args[1])]
    : [ex(e, ATOM)];
  const joined = (e: Json): string => {
    const [first, ...rest] = parts(e);
    const args = rest.reduce<(string | string[])[]>((all, p) => (Array.isArray(p) && Array.isArray(all.at(-1)) ? [...all.slice(0, -1), [...all.at(-1)!, ...p]] : [...all, p]), []);
    return `${first as string}.concat(${args.map((p) => (Array.isArray(p) ? `[${p.join(", ")}]` : p)).join(", ")})`;
  };
  /** A lambda, or with `not` its negation. Its parameters carry their types, which LemmaScript cannot always infer. */
  const arrow = (params: Json[], result: Json, not = false): string => {
    // A parameter hides an enclosing match arm's binder of the same name: inside the lambda the name is the parameter.
    const hidden = params.map((p) => [p.name, renamed.get(p.name), matchedAs.get(p.name)] as const);
    for (const [n] of hidden) { renamed.delete(n); matchedAs.delete(n); }
    const text = scoped(params.map((p) => p.name), () => not ? `!${ex(result, ATOM)}` : ex(result, TERNARY));
    for (const [n, r, m] of hidden) { restore(renamed, n, r); restore(matchedAs, n, m); }
    const param = (p: Json) => (inferred(p.id) ? `${bind(p.name)}: ${tsType(typeOf(p.id))}` : bind(p.name));
    return `(${params.map(param).join(", ")}) => ${text.startsWith("{") ? `(${text})` : text}`;
  };

  const print = (e: Json): [string, number] => {
    switch (e.kind) {
      case "int":
        if (!Number.isSafeInteger(e.value)) fail(`integer literal ${e.value} is beyond 2^53 and would lose precision in TypeScript`);
        return [String(e.value), e.value < 0 ? UNARY : ATOM];
      case "bool": return [String(e.value), ATOM];
      case "str": return [JSON.stringify(e.value), ATOM];
      case "name": {
        if (!locals.has(e.name) && simulatorOnly.has(e.name)) return forSimulator(e.name);
        if (renamed.has(e.name)) return fail(`\`${e.name}\` is what a match arm carries; use its fields (${e.name}.field), or rebuild the variant, rather than the value as a whole`);
        if (!variants.has(e.name)) return [reference(e.name), ATOM];
        const owner = ownerOf(e.name);
        return [tagged(owner.type) ? `({ tag: ${tag(e.name)} } as ${typeName(owner)})` : tag(e.name), ATOM];
      }
      case "let": return fail(`\`val ${e.opdef.name}\` must be at the top of a definition, not inside an expression`);
      case "lambda": return [arrow(e.params, e.expr), ARROW];
      case "app": break;
      default: return fail(`unsupported expression kind ${e.kind}`);
    }
    const a: Json[] = e.args;
    const op: string = e.opcode;
    if (!OPERATORS.has(op) && !BUILTIN.test(op) && !variants.has(op) && !definitions.has(op))
      return simulatorOnly.has(op) ? forSimulator(op) : fail(`\`${op}\` is not in the Quint a spec may use (SPEC.md, "Supported Quint"); write it with the operators listed there`);
    if (negative(e)) return print(negative(e));
    if (BINARY[op]) {
      const [symbol, prec] = BINARY[op];
      const structural = (op === "eq" || op === "neq") && !isScalar(typeOf(a[0].id)) && comparable(a[0]);
      if (structural && !proof) return op === "eq" ? [equal(ex(a[0], TERNARY), ex(a[1], TERNARY)), ATOM] : [`!${equal(ex(a[0], TERNARY), ex(a[1], TERNARY))}`, UNARY];
      const text = `${ex(a[0], prec)} ${symbol} ${ex(a[1], prec + 1)}`;
      return prec === ADD || prec === MULTIPLY ? exact(text, prec) : [text, prec];
    }
    const recv = () => ex(a[0], ATOM);
    const builtin = op.match(BUILTIN)?.[1];
    // Outside the list, nthOr gives the default and removeAt the list as it is, as their Quint does (BUILTINS).
    const inRange = () => `0 <= ${ex(a[1], COMPARE + 1)} && ${ex(a[1], COMPARE + 1)} < ${recv()}.length`;
    if (builtin === "getOr") return lookup(a[0], a[1], a[2]);
    if (builtin === "nthOr") return [`${inRange()} ? ${recv()}[${ex(a[1])}] : ${ex(a[2], OR)}`, TERNARY];
    if (builtin === "removeAt") return [`${inRange()} ? ${recv()}.slice(0, ${ex(a[1])}).concat(${recv()}.slice(${ex(a[1], ADD)} + 1)) : ${recv()}`, TERNARY];
    switch (op) {
      case "iuminus": return exact(`0 - ${ex(a[0], ADD + 1)}`, ADD); // not -x: in JavaScript that gives -0 for 0
      // Quint divides towards zero, and its remainder takes the sign of the dividend. JavaScript's floor and Dafny's
      // division do neither for negative numbers, so both go through helpers that are exact in all three.
      case "idiv": helpers.add("quotient"); return [`${helper("quotient")}(${ex(a[0], TERNARY)}, ${ex(a[1], TERNARY)})`, ATOM];
      case "imod": helpers.add("quotient").add("remainder"); return [`${helper("remainder")}(${ex(a[0], TERNARY)}, ${ex(a[1], TERNARY)})`, ATOM];
      // A map is an object. Looking a key up is only safe where the same definition has tested for it.
      case "Map": return [a.reduce((m, pair) => put(m, typeOf(e.id), mapKey(e, pair.args[0]), ex(pair.args[1], TERNARY)), `({} as ${tsType(typeOf(e.id))})`), ATOM];
      case "put": case "set": return [put(recv(), typeOf(a[0].id), mapKey(a[0], a[1]), ex(a[2], TERNARY)), ATOM];
      case "get": return partial("get", recv(), mapKey(a[0], a[1]));
      case "keys": return fail("a map cannot be listed or iterated, only asked about one key: write `m.keys().contains(k)`, and keep a list of keys beside the map if you need to go through them");
      case "not": return [`!${ex(a[0], ATOM)}`, UNARY];
      case "and": return [flat(e, "and").map((x) => ex(x, AND + 1)).join(" && "), AND];
      case "or": return [flat(e, "or").map((x) => ex(x, AND + 1)).join(" || "), OR];
      case "implies": return [`!${ex(a[0], ATOM)} || ${ex(a[1], AND + 1)}`, OR];
      case "iff": return [`${ex(a[0], EQ + 1)} === ${ex(a[1], EQ + 1)}`, EQ];
      case "ite": return [`${ex(a[0], OR)} ? ${ex(a[1], OR)} : ${ex(a[2], OR)}`, TERNARY];
      case "field": return [`${a[0].kind === "name" && renamed.has(a[0].name) ? renamed.get(a[0].name) : recv()}.${a[1].value}`, ATOM];
      case "Rec": return [typed(`{ ${pairs(a).join(", ")} }`, e), ATOM];
      case "with": {
        const { base, updates } = unroll(e);
        return [typed(`{ ...${ex(base, ATOM)}, ${updates.join(", ")} }`, e), ATOM];
      }
      // An empty list carries its type, which TypeScript cannot infer where it is a fold's starting value.
      case "List": return [a.length ? `[${a.map((x) => ex(x, TERNARY)).join(", ")}]` : `([] as ${tsType(typeOf(e.id))})`, ATOM];
      case "append": case "concat": return [joined(e), ATOM];
      case "length": return [`${recv()}.length`, ATOM];
      case "nth": return partial("nth", recv(), ex(a[1]));
      case "head": return partial("nth", recv(), "0");
      case "tail": return [`${recv()}.slice(1)`, ATOM];
      case "select": return [`${recv()}.filter(${ex(a[1])})`, ATOM];
      case "foldl": {
        // A fold whose accumulator is marked is one of the list helpers, expanded by the tangler.
        const [acc, item] = a[2].kind === "lambda" ? a[2].params : [];
        const which = acc?.name.match(LIST_HELPER)?.[1] ?? "";
        const method = LIST_HELPERS[which]?.method;
        const inner = a[2].expr?.args?.[1];
        if (which === "every") return [`!${recv()}.some(${arrow([item], inner, true)})`, UNARY];
        if (method) return [`${recv()}.${method}(${arrow([item], inner)})`, ATOM];
        if (which === "includes") {
          const [v, t] = [inner.args[1], typeOf(inner.args[1].id)];
          return [isScalar(t) || (comparable(v) && proof) ? `${recv()}.includes(${ex(v, TERNARY)})` : `${recv()}.some((x0: ${tsType(t)}) => ${equal("x0", ex(v, TERNARY))})`, ATOM];
        }
        return [`${recv()}.reduce(${ex(a[2])}, ${ex(a[1], TERNARY)})`, ATOM];
      }
    }
    if (variants.has(op)) {
      // A variant that carries a record: Paid({ receipt: 7 }) is { tag: "Paid", receipt: 7 }.
      const owner = ownerOf(op);
      // Updating the matched value in place: Packed({ ...x, labels: … }) inside the Packed arm keeps the tag it has.
      const { base, updates } = unroll(a[0]);
      if (base.kind === "name" && matchedAs.get(base.name) === op.split("::").pop())
        return [updates.length ? `({ ...${renamed.get(base.name)}, ${updates.join(", ")} } as ${typeName(owner)})` : renamed.get(base.name)!, ATOM];
      if (a[0].kind !== "app" || a[0].opcode !== "Rec") fail(`${op}(…): give the record field by field, or update the value matched in the ${op} arm`);
      return [`({ ${[`tag: ${tag(op)}`, ...pairs(a[0].args)].join(", ")} } as ${typeName(owner)})`, ATOM];
    }
    if (op === "matchVariant") {
      // match o { | Draft(d) => … | _ => … } becomes a chain of tests on the tag, with d standing for o itself.
      if (a[0].kind !== "name") fail("`match` must be on a name; bind the value with `val` first");
      const subject = ex(a[0], ATOM);
      const isTagged = tagged(resolve(typeOf(a[0].id)));
      const arms: { test?: string; result: string }[] = [];
      for (let i = 1; i < a.length; i += 2) {
        const binder = a[i + 1].params[0]?.name;
        // Inside the arm the binder stands for the matched value; an outer arm's binder of the same name comes back after.
        const bound = binder && binder !== "_";
        const outer = bound ? [renamed.get(binder), matchedAs.get(binder)] : [];
        if (bound) { renamed.set(binder, subject); matchedAs.set(binder, a[i].value); }
        const result = ex(a[i + 1].expr, OR);
        if (bound) { restore(renamed, binder, outer[0]); restore(matchedAs, binder, outer[1]); }
        arms.push({ test: a[i].value === "_" ? undefined : `${subject}${isTagged ? ".tag" : ""} === ${JSON.stringify(a[i].value)}`, result });
      }
      const last = arms.pop()!;
      return [arms.reduceRight((rest, arm) => `${arm.test} ? ${arm.result} : ${rest}`, last.result), arms.length ? TERNARY : OR];
    }
    const [x, y] = members(op, a);
    if ((op === "contains" || op === "in") && x.opcode === "keys") return [`(${mapKey(x.args[0], y)}) in ${ex(x.args[0], COMPARE + 1)}`, COMPARE];
    if (SET_OPS[op]) {
      // A set is an array that never holds the same value twice. Only simple values can be in one.
      const t = resolve(typeOf(x.id));
      if (t.kind !== "set") return fail(`\`${op}\` is supported on sets only`);
      const el = tsType(setElem(t));
      // What `map` makes is a set too, so it is held to the same rule as what it maps.
      const not = () => (y.kind === "lambda" ? arrow(y.params, y.expr, true) : `(set_x: ${el}) => !${ex(y, ATOM)}(set_x)`);
      const text = SET_OPS[op]({ a: ex(x, ATOM), b: y && ex(y, y.kind === "lambda" ? ARROW : ATOM), el, out: op === "map" ? tsType(setElem(resolve(typeOf(e.id)))) : el, not });
      return [text, text.startsWith("!") ? UNARY : ATOM];
    }
    if (op === "Set") {
      const t = resolve(typeOf(e.id));
      setElem(t);
      const distinct = [...new Set(a.map((x) => ex(x, TERNARY)))];
      const literal = (x: Json) => ["int", "str", "bool"].includes(x.kind) || !!negative(x) || (x.kind === "name" && variants.has(x.name));
      if (a.length > 1 && !a.every(literal)) fail("Set(…) with several members that are not literals could hold the same value twice; write Set(a).union(Set(b))");
      return [distinct.length ? `[${distinct.join(", ")}]` : `([] as ${tsType(t.elem)}[])`, ATOM];
    }
    return [`${reference(op)}(${a.map((x) => ex(x, TERNARY)).join(", ")})`, ATOM];
  };

  /** A definition body: leading `val`s become `const`s, the rest is returned. */
  const body = (e: Json, params: Json[] = []): string[] => scoped(params.map((p) => p.name), () => {
    const lines: string[] = [];
    for (; e.kind === "let"; e = e.expr) {
      if (e.opdef.expr.kind === "lambda") fail(`local def ${e.opdef.name} is not supported`);
      const t = typeOf(e.opdef.expr.id);
      const annotation = resolve(t).kind === "sum" ? `: ${tsType(t)}` : "";
      const name = bind(e.opdef.name);
      const local = `local_${localId++}`;
      lines.push(`const ${local}${annotation} = ${ex(e.opdef.expr)};`);
      locals.set(name, local);
    }
    return [...lines, `return ${ex(e)};`];
  });

  return { ex, body, helpers, lookups, proof };
}
export type Printer = ReturnType<typeof printer>;
