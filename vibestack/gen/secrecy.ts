// Which values carry a secret, and where they may go (SPEC.md, "Secrets"). A type named Secret<Something> marks
// its values secret. A secret may be kept only in a place whose type is secret: a field, a variant's field, a list,
// set or map element, or the result of a definition. Every other place is public, since the program may say, log or
// show it. A value computed from a secret, or chosen by a condition on one, is secret too. A definition named
// declassify<Something> is the one way out: what it returns is public, and review names it (review.ts, `pending`).
import { fail, type Json, type Types } from "./types.ts";
import type { Param, Roles } from "./classify.ts";

const SECRET = /^Secret[A-Z0-9_]/;
export const DECLASSIFY = /^declassify[A-Z]/;

interface Flow {
  funs: Json[];
  vals: Json[];
  sig: (d: Json) => { params: Param[]; result: Json };
  inferred: (id: number) => Json | undefined;
  /** Where a definition is in the spec, for messages. */
  where: (def: string) => string;
  variants: Set<string>;
}

/** Fails with every place a secret reaches that is not secret. */
export function checkSecrets({ funs, vals, sig, inferred, where, variants }: Flow, roles: Roles, { typedef, resolve, fields, payload, ownerOf, named }: Types) {
  /** A type that is secret itself, directly or as an alias of one, or a list, set or map of such: what is read from it is secret. */
  const secret = (t: Json | undefined): boolean => (t?.kind === "const" ? SECRET.test(t.name.split("::").pop()) || SECRET.test(typedef(t.name).base ?? "") || secret(typedef(t.name).type)
    : t?.kind === "list" || t?.kind === "set" ? secret(t.elem) : t?.kind === "fun" && secret(t.res));
  const name = (t: Json) => (t.kind === "const" ? t.name : t.kind);
  const byName = new Map(funs.map((d) => [d.name as string, d]));
  const valsByName = new Map(vals.map((d) => [d.name as string, d]));
  // Rules only check, so what they return goes nowhere; opaque laws are rules too.
  const rules = new Set([...roles.always, ...roles.sometimes, ...roles.steps.map((r) => r.name), ...roles.leadsTo,
    ...[...roles.laws, ...roles.opaques.flatMap((o) => o.laws)].map((l) => l.name), ...(roles.refines ? [roles.refines.fn] : [])]);
  const found = new Set<string>();
  /** The field `f` of a record type, as declared. */
  const field = (t: Json | undefined, f: string): Json | undefined => {
    const r = t && resolve(t);
    return r?.kind === "rec" ? fields(r).find((x: Json) => x.fieldName === f)?.fieldType : undefined;
  };
  const elem = (t: Json | undefined): Json | undefined => { const r = t && resolve(t); return r?.kind === "list" || r?.kind === "set" ? r.elem : r?.kind === "fun" ? r.res : undefined; };
  // Types as the spec declares them: an inferred type may have lost the name of a secret type to unification.
  const result = (d: Json): Json => d.typeAnnotation?.res ?? sig(d).result;
  /** The declared type of a record value: the place it goes into, else the named type with its fields. */
  const declared = (e: Json, slot: Json | undefined) => slot ?? named(inferred(e.id) ?? { kind: "none" }, "rec")?.type ?? inferred(e.id);

  /**
   * Whether `e` carries a secret, with `env` saying which names do. `slot` is the declared type of the place `e`
   * goes into, which a record literal's fields are checked against.
   */
  const carries = (e: Json, env: Map<string, boolean>, at: string, slot?: Json): boolean => {
    const own = secret(inferred(e.id));
    /** Whether `x` carries a secret into a place of type `t`, which must then be secret. */
    const into = (x: Json, t: Json | undefined, what: string): boolean => {
      const carried = carries(x, env, at, t);
      if (carried && !secret(t)) found.add(`${at}: a secret reaches ${what}${t ? `, of type ${name(t)},` : ""} which is not secret: give that place a Secret type, or pass the value through a declassify function`);
      return carried;
    };
    // A lambda's parameters carry what the values it is applied to carry.
    const all = (xs: Json[]) => {
      const outer = xs.filter((x) => x.kind !== "lambda").map((x) => carries(x, env, at)).some(Boolean);
      return xs.filter((x) => x.kind === "lambda").map((l) => carries(l.expr, new Map([...env, ...l.params.map((p: Json) => [p.name, outer || secret(inferred(p.id))] as const)]), at)).some(Boolean) || outer;
    };
    if (e.kind === "name") return own || (env.get(e.name) ?? valCarries(e.name));
    if (e.kind === "let") return carries(e.expr, new Map([...env, [e.opdef.name, carries(e.opdef.expr, env, at)]]), at, slot);
    if (e.kind !== "app") return own;
    const a: Json[] = e.args;
    const op: string = e.opcode;
    if (DECLASSIFY.test(op.split("::").pop()!)) { all(a); return false; }
    if (byName.has(op)) return own || call(op, a.map((x) => carries(x, env, at)));
    if (variants.has(op)) {
      const tag = op.split("::").pop()!;
      if (a.length) into(a[0], payload(fields(ownerOf(op).type).find((f: Json) => f.fieldName === tag)), `the payload of ${tag}`);
      return false;
    }
    if (op === "Rec") {
      const t = declared(e, slot);
      for (let i = 0; i < a.length; i += 2) into(a[i + 1], field(t, a[i].value), `the field ${a[i].value}`);
      return false;
    }
    if (op === "with") {
      into(a[2], field(declared(e, slot), a[1].value), `the field ${a[1].value}`);
      return carries(a[0], env, at, slot);
    }
    // A collection is as secret as what it holds: whatever reads an element reads a secret.
    if (op === "List" || op === "Set") return a.map((x) => into(x, elem(slot ?? inferred(e.id)), "an element of a collection")).some(Boolean);
    if (op === "append") return [into(a[1], elem(slot ?? inferred(e.id)), "an element of a list"), carries(a[0], env, at, slot)].some(Boolean);
    if (op === "put" || op === "set") return [into(a[2], elem(slot ?? inferred(e.id)), "a value in a map"), carries(a[0], env, at, slot), carries(a[1], env, at)].some(Boolean);
    if (op === "field") return own || secret(field(inferred(a[0].id), a[1].value)) || carries(a[0], env, at);
    return own || all(a);
  };

  const valMemo = new Map<string, boolean>();
  const valCarries = (n: string): boolean => {
    const d = valsByName.get(n);
    if (!d) return false;
    if (!valMemo.has(n)) valMemo.set(n, carries(d.expr, new Map(), where(n), d.typeAnnotation ?? inferred(d.id)));
    return valMemo.get(n)!;
  };
  /** What a definition returns carries a secret, given which of its arguments do. Quint has no recursion, so this ends. */
  const memo = new Map<string, boolean>();
  const call = (fn: string, args: boolean[]): boolean => {
    const key = `${fn}(${args.map(Number).join("")})`;
    if (!memo.has(key)) {
      const d = byName.get(fn)!;
      const env = new Map<string, boolean>(d.expr.params.map((p: Json, i: number) => [p.name, args[i] || secret(p.typeAnnotation ?? sig(d).params[i].type)]));
      memo.set(key, carries(d.expr.expr, env, where(fn), result(d)));
    }
    return memo.get(key)!;
  };
  for (const v of vals) {
    const t = v.typeAnnotation ?? inferred(v.id);
    if (valCarries(v.name) && !secret(t)) found.add(`${where(v.name)}: it holds a secret, but its type ${name(t)} is not secret`);
  }
  // Each definition on its own, its parameters as secret as their types say.
  for (const d of funs)
    if (call(d.name, d.expr.params.map(() => false)) && !rules.has(d.name) && !DECLASSIFY.test(d.name) && !secret(result(d)))
      found.add(`${where(d.name)}: what it returns depends on a secret, but its type ${name(result(d))} is not secret: give it a Secret type, or decide by something public`);
  if (found.size) fail([...found].join("\n"));
}
