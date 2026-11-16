// Quint types as the type checker reports them, and everything that is decided by walking one: how TypeScript and
// the harness spell it, how an untrusted value is tested and copied, and how a value in a simulated trace is read.
import type { ComparisonShape } from "../conformance.ts";

export type Json = any;
export const fail = (msg: string): never => { throw new Error(msg); };

/** Reads the type the checker inferred for an expression, failing where it recorded none. */
export const typeOfIn = (inferred: (id: number) => Json | undefined) => (id: number): Json => inferred(id) ?? fail(`no inferred type for expression ${id}`);

const PRIMITIVE: Record<string, string> = { int: "number", bool: "boolean", str: "string" };

/**
 * `typedefs` are the types a module can name: its own and those of the specs it imports. A type the module defines
 * is spelled with `prefix` in TypeScript; one from another module is spelled <module>_<name>.
 */
export function typeWalks(typedefs: Json[], module: string, prefix = "") {
  const fields = (t: Json): Json[] => t.kind === "rec" && t.fields.fields.some((f: Json) => f.fieldName === "__proto__")
    ? fail("a record field cannot be called `__proto__`, which JavaScript reads as the object's prototype") : t.fields.fields;
  // Quint sometimes names a type from a module imported under a name without that name; `base` finds it.
  const typedef = (n: string): Json => typedefs.find((d) => d.name === n) ?? typedefs.find((d) => d.base === n) ?? fail(`unknown type ${n}`);
  const resolve = (t: Json): Json => (t.kind === "const" ? resolve(typedef(t.name).type) : t);
  /** Structural identity, so inferred types can be matched back to their names. */
  const shape = (t0: Json): string => {
    const t = resolve(t0);
    if (t.kind === "rec") return `{${fields(t).map((f) => `${f.fieldName}:${shape(f.fieldType)}`).sort().join(",")}}`;
    if (t.kind === "sum") return `<${fields(t).map((f) => f.fieldName + (payload(f) ? shape(payload(f)) : "")).sort().join(",")}>`;
    if (t.kind === "list") return `[${shape(t.elem)}]`;
    if (t.kind === "set") return `(${shape(t.elem)})`;
    if (t.kind === "fun") return `${shape(t.arg)}=>${shape(t.res)}`;
    return t.kind;
  };
  /** The record a variant carries, if it carries one. */
  function payload(variant: Json): Json | undefined {
    const t = variant.fieldType;
    if (t.kind === "tup" && !(t.fields.fields ?? []).length) return undefined;
    const carried = resolve(t).kind === "rec" ? resolve(t) : fail(`variant ${variant.fieldName}: a variant may carry a record, as in ${variant.fieldName}({ amount: int }), and nothing else`);
    if (fields(carried).some((f) => f.fieldName === "tag")) fail(`variant ${variant.fieldName}: a field cannot be called \`tag\`, which is how the variant itself is recorded`);
    return carried;
  }
  const carriedBy = (t: Json, tag: string) => payload(fields(t).find((f) => f.fieldName === tag)!);
  /** A sum type is a plain string union unless some variant carries data; then it is a tagged union. */
  const tagged = (t: Json) => t.kind === "sum" && fields(t).some((f) => payload(f));
  const isScalar = (t: Json) => ["int", "bool", "str"].includes(resolve(t).kind) || (resolve(t).kind === "sum" && !tagged(resolve(t)));
  /**
   * The declared type with this structure, if there is one. TypeScript would accept either of two types with the same
   * fields, but Dafny would not, so a structure that two distinct types share is refused rather than guessed at. The same
   * type reached by two routes (imported directly and through another spec), or an alias of it, is not two types.
   */
  const named = (t: Json, kind?: string): Json | undefined => {
    const want = shape(t);
    const found = typedefs.filter((d) => (!kind || d.type.kind === kind) && shape(d.type) === want);
    const real = found.filter((d) => d.type.kind !== "const");
    const distinct = [...new Map(real.map((d) => [`${d.module}.${d.base ?? d.name}`, d])).values()];
    if (distinct.length > 1) fail(`types ${distinct.map((d) => d.name).join(" and ")} have the same fields, so a value of either cannot be told apart from the other; give one of them a field of its own`);
    return distinct[0] ?? found[0];
  };
  /** A set's element type, refused unless it is a simple value: a set is an array that never holds the same value twice, which is only checkable for those. */
  const setElem = (t: Json): Json => (isScalar(t.elem) ? t.elem : fail("sets of records or lists are not supported; use a list"));
  /**
   * A map's key type: an integer, a string or a plain variant. In TypeScript a map is an object, which makes every key
   * a string, so a string key is stored with a "$" in front (no key can then be a property every object has, such as
   * "constructor"), and a variant may not be named like one. The proof sees a Dafny `map` from the key type itself.
   */
  const keyOf = (t: Json): Json => {
    const k = resolve(t.arg);
    if (!isScalar(k) || k.kind === "bool") fail("a map's keys must be integers, strings or the variants of a type whose variants carry no data");
    const clash = k.kind === "sum" && fields(k).find((f) => f.fieldName in Object.prototype);
    return clash ? fail(`variant ${clash.fieldName} cannot be a map's key: every JavaScript object has a property of that name`) : k;
  };
  /** A key as the generated object stores it. */
  const storedKey = (t: Json, k: string) => (keyOf(t).kind === "str" ? `"$" + ${k}` : k);
  /** Whether a value of the type can hold a set: equality would compare it in order in the proof, where a set is a sequence. */
  const holdsSet = (t0: Json): boolean => {
    const t = resolve(t0);
    return t.kind === "set" || (t.kind === "list" && holdsSet(t.elem)) || (t.kind === "fun" && holdsSet(t.res))
      || (t.kind === "rec" && fields(t).some((f) => holdsSet(f.fieldType))) || (tagged(t) && fields(t).some((f) => !!payload(f) && holdsSet(payload(f)!)));
  };
  /** The type a variant belongs to. */
  const ownerOf = (variant: string): Json => {
    const [base, alias] = variant.split("::").reverse();
    return typedefs.find((d) => d.type.kind === "sum" && d.alias === alias && fields(d.type).some((f: Json) => f.fieldName === base)) ?? fail(`unknown variant ${variant}`);
  };

  // --- spellings -------------------------------------------------------------
  const typeName = (d: Json): string => (d.module === module ? prefix + d.name : `${d.module}_${d.base}`);
  const tsType = (t: Json): string => {
    // An alias of int, bool or str is spelled as what it names: LemmaScript reads a comparison of such an alias with a
    // string literal as a test of a variant's tag.
    if (PRIMITIVE[resolve(t).kind]) return PRIMITIVE[resolve(t).kind];
    if (t.kind === "const") return typeName(typedef(t.name));
    if (t.kind === "list") return `${tsType(t.elem)}[]`;
    if (t.kind === "set") return `${tsType(setElem(t))}[]`;
    if (t.kind === "fun") return `Record<${tsType(keyOf(t))}, ${tsType(t.res)}>`;
    const d = named(t);
    return d ? typeName(d) : fail(`a ${t.kind} type is not in the Quint a spec may use (SPEC.md, "Supported Quint"); name it with \`type\` or use a supported one`);
  };
  /** The TypeScript declaration of one of the module's own types. */
  const declaration = (d: Json): string => {
    const t = d.type;
    if (tagged(t)) {
      const variant = (f: Json) => `{ ${[`tag: ${JSON.stringify(f.fieldName)}`, ...(payload(f) ? fields(payload(f)).map((x: Json) => `${x.fieldName}: ${tsType(x.fieldType)}`) : [])].join("; ")} }`;
      return `export type ${prefix}${d.name} =\n${fields(t).map((f) => `  | ${variant(f)}`).join("\n")};`;
    }
    if (t.kind === "sum") return `export type ${prefix}${d.name} = ${fields(t).map((f) => JSON.stringify(f.fieldName)).join(" | ")};`;
    if (t.kind === "rec")
      return `export interface ${prefix}${d.name} { ${fields(t).map((f) => `${f.fieldName}: ${tsType(f.fieldType)}`).join("; ")} }`;
    return `export type ${prefix}${d.name} = ${tsType(t)};`;
  };
  /** A type as the harness writes it: named types by the module that defines them. */
  const qType = (t: Json): string => {
    if (PRIMITIVE[t.kind]) return t.kind;
    if (t.kind === "list") return `List[${qType(t.elem)}]`;
    if (t.kind === "set") return `Set[${qType(t.elem)}]`;
    if (t.kind === "fun") return `(${qType(t.arg)} -> ${qType(t.res)})`;
    const d = t.kind === "const" ? typedef(t.name) : named(t);
    return d ? `${d.module === module ? "M" : `D_${d.module}`}::${d.base ?? d.name}` : fail("a type with no name");
  };

  // --- untrusted values --------------------------------------------------------
  /**
   * Runtime tests that an untrusted value inhabits a type: `test` is the expression for one value, and `lines` declare
   * the function it calls for each named record or variant type, so that a type is tested by one text however many
   * places hold it. `exact` is for a whole state: a record or variant may have no field beyond those its type names,
   * and a map is allowed, as a record whose keys are stored as the generated code stores them (keyOf).
   */
  const validators = (exact = false) => {
    const made = new Map<string, string>();
    const test = (v: string, t0: Json, depth = 0, own = false): string => {
      const t = resolve(t0);
      if (t.kind === "int") return `Number.isSafeInteger(${v})`;
      if (t.kind === "bool") return `typeof ${v} === "boolean"`;
      if (t.kind === "str") return `typeof ${v} === "string"`;
      if (t.kind === "sum" && !tagged(t)) return `(${fields(t).map((f) => `${v} === ${JSON.stringify(f.fieldName)}`).join(" || ")})`;
      if (t0.kind === "const" && !own) {
        const fn = `is_${typeName(typedef(t0.name))}`;
        if (!made.has(fn)) made.set(fn, `  const ${fn} = (v: any): boolean => ${test("v", t0, 0, true)};`);
        return `${fn}(${v})`;
      }
      const x = `x${depth}`;
      const object = `typeof ${v} === "object" && ${v} !== null && !Array.isArray(${v})`;
      const sized = (n: number) => (exact ? [`Object.keys(${v}).length === ${n}`] : []);
      const record = (r: Json) => fields(r).map((f) => test(`${v}.${f.fieldName}`, f.fieldType, depth + 1));
      if (tagged(t)) return `${object} && (${fields(t).map((f) => [`${v}.tag === ${JSON.stringify(f.fieldName)}`, ...(payload(f) ? record(payload(f)!) : []), ...sized(1 + (payload(f) ? fields(payload(f)!).length : 0))].join(" && ")).join(" || ")})`;
      if (t.kind === "list" || t.kind === "set")
        return `Array.isArray(${v}) && ${v}.every((${x}: any) => ${test(x, t.elem, depth + 1)})${t.kind === "set" ? ` && new Set(${v}).size === ${v}.length` : ""}`;
      if (t.kind === "rec") return [object, ...record(t), ...sized(fields(t).length)].join(" && ");
      if (t.kind === "fun") {
        if (!exact) return fail("an event cannot carry a map; send a list of records instead");
        const [k, key] = [keyOf(t), `k${depth}`];
        const stored = k.kind === "str" ? `${key}.startsWith("$")`
          : k.kind === "int" ? `/^(0|-?[1-9][0-9]*)$/.test(${key}) && Number.isSafeInteger(Number(${key}))`
          : `(${fields(k).map((f) => `${key} === ${JSON.stringify(f.fieldName)}`).join(" || ")})`;
        return `${object} && Object.entries(${v}).every(([${key}, ${x}]: [string, any]) => ${stored} && ${test(x, t.res, depth + 1)})`;
      }
      return fail(`a parameter of type ${t.kind} is not supported`);
    };
    return { test, lines: () => [...made.values()] };
  };
  /** A copy of a checked value that has the fields its type names and no others. */
  const copy = (v: string, t0: Json, depth = 0): string => {
    const t = resolve(t0);
    const x = `x${depth}`;
    const record = (r: Json) => fields(r).map((f) => `${f.fieldName}: ${copy(`${v}.${f.fieldName}`, f.fieldType, depth + 1)}`);
    const variant = (f: Json) => `{ ${[`tag: ${v}.tag`, ...(payload(f) ? record(payload(f)!) : [])].join(", ")} }`;
    if (tagged(t)) return `(${fields(t).slice(0, -1).map((f) => `${v}.tag === ${JSON.stringify(f.fieldName)} ? ${variant(f)} : `).join("")}${variant(fields(t).at(-1)!)})`;
    if (t.kind === "list" || t.kind === "set") return `${v}.map((${x}: any) => ${copy(x, t.elem, depth + 1)})`;
    if (t.kind === "rec") return `({ ${record(t).join(", ")} })`;
    if (t.kind === "fun") return `Object.fromEntries(Object.entries(${v}).map(([k${depth}, ${x}]: [string, any]) => [k${depth}, ${copy(x, t.res, depth + 1)}]))`;
    return v;
  };

  // --- values in a simulated trace -----------------------------------------------
  /** A value from a Quint trace (ITF) as the generated TypeScript represents it. */
  const decode = (t0: Json, v: any): any => {
    const t = resolve(t0);
    if (t.kind === "int") {
      // A trace writes every integer as {"#bigint": "<digits>"}. One beyond 2^53 would be silently rounded by Number.
      const n = typeof v?.["#bigint"] === "string" ? BigInt(v["#bigint"]) : typeof v === "number" ? v : fail(`a trace holds ${JSON.stringify(v)} where an integer belongs`);
      return Number.isSafeInteger(Number(n)) ? Number(n)
        : fail(`a simulated trace reached the integer ${n}, which is beyond 2^53 and so cannot be represented exactly in TypeScript; bound it with a guard`);
    }
    if (t.kind === "list") return v.map((x: any) => decode(t.elem, x));
    if (t.kind === "set") return v["#set"].map((x: any) => decode(t.elem, x));
    if (t.kind === "rec") return Object.fromEntries(fields(t).map((f) => [f.fieldName, decode(f.fieldType, v[f.fieldName])]));
    if (t.kind === "fun") return Object.fromEntries(v["#map"].map(([k, x]: [any, any]) => [keyOf(t).kind === "str" ? "$" + decode(t.arg, k) : decode(t.arg, k), decode(t.res, x)]));
    if (tagged(t)) {
      const carried = carriedBy(t, v.tag);
      return { tag: v.tag, ...(carried ? decode(carried, v.value) : {}) };
    }
    return t.kind === "sum" ? v.tag : v;
  };
  /** The same value with every set in a fixed order, so that two sets compare equal however they were built. */
  const canon = (t0: Json, v: any): any => {
    const t = resolve(t0);
    if (t.kind === "int") return v + 0; // -0 (from 0 * -1, say) prints as 0 and is the same integer, but would compare unequal
    if (t.kind === "list") return v.map((x: any) => canon(t.elem, x));
    if (t.kind === "set") return v.map((x: any) => canon(t.elem, x)).sort((x: any, y: any) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
    if (t.kind === "rec") return Object.fromEntries(fields(t).map((f) => [f.fieldName, canon(f.fieldType, v[f.fieldName])]));
    if (t.kind === "fun") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(t.res, x)]));
    if (tagged(t)) {
      const carried = carriedBy(t, v.tag);
      return carried ? { tag: v.tag, ...canon(carried, v) } : v;
    }
    return v;
  };

  /** The shape needed to compare observations, preserving list order while ignoring the order of sets. */
  const comparison = (t0: Json): ComparisonShape => {
    const t = resolve(t0);
    if (t.kind === "set") return { set: comparison(setElem(t)) };
    if (t.kind === "list") return { list: comparison(t.elem) };
    if (t.kind === "fun") return { map: comparison(t.res) };
    if (t.kind === "rec") return { fields: Object.fromEntries(fields(t).map((f) => [f.fieldName, comparison(f.fieldType)])) };
    if (tagged(t)) return { variants: Object.fromEntries(fields(t).map((f) => [f.fieldName, payload(f) ? comparison(payload(f)) : { fields: {} }])) };
    if (t.kind === "sum" || PRIMITIVE[t.kind]) return "scalar";
    return fail(`a comparison of type ${t.kind} is not supported`);
  };

  return { fields, typedef, resolve, shape, payload, tagged, isScalar, setElem, keyOf, storedKey, holdsSet, named, ownerOf, typeName, tsType, declaration, qType, validators, copy, decode, canon, comparison };
}
export type Types = ReturnType<typeof typeWalks>;
