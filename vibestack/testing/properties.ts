// Properties of an Effect Schema, and of a function under a declared contract, checked by Effect's own Arbitrary
// runner. generate.ts writes a test for each from `src/**/*.schema.{ts,vibe}` and `src/**/*.contract.{ts,vibe}`.
import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Equal, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { profile, type TestProfile } from "./profile.ts";

// Vite supplies MODE in a test worker; the generator also imports this module directly in Node.
const mode: TestProfile = (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === "nightly" ? "nightly" : "normal";

/** The fixed profile selected by `vitest run`, or by `vitest run --mode nightly`. */
export const fuzz = profile(mode);

/** Where a property's values come from. */
export type Source<A> = Schema.Schema<A> | Arbitrary.Arbitrary<A>;

/**
 * Check `property` on `fuzz.runs` values of `source`, in an `it.effect`; `options` replace what they name of `fuzz`.
 * A failure carries the shrunk counterexample, the seed and the command that repeats it.
 */
export const holds = <A>(source: Source<A>, property: (value: A) => boolean, options?: Arbitrary.CheckOptions) => {
  const used = { ...fuzz, ...options };
  return Arbitrary.checkEffect(
    Arbitrary.isArbitrary(source) ? source : Arbitrary.schema(source),
    // A property that throws is falsified by its cause, as in @effect/vitest's it.prop.
    (value) => Effect.catchCause(Effect.sync(() => property(value)), (cause) => Effect.fail(cause)),
    used,
  ).pipe(Effect.flatMap((result) => {
    const failure = Arbitrary.formatCheckFailure(result);
    if (failure === undefined) return Effect.void;
    const file = expect.getState().testPath;
    const replay = `const path = require("node:path"); const cli = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs"); const run = require("node:child_process").spawnSync(process.execPath, [cli, ...${JSON.stringify(["run", ...file ? [file] : [], "--mode", mode === "nightly" ? "nightly" : "test"])}], { stdio: "inherit" }); if (run.error) throw run.error; process.exit(run.status ?? 1);`;
    const command = `node -e "eval(Buffer.from('${Base64.encode(replay)}','base64').toString())"`;
    return Effect.die(new Error(`${failure}\nSeed: ${used.seed}\nRerun: ${command}`));
  }));
};

/** Decoding what was encoded gives the value back. */
export function roundTrips<A, I>(schema: Schema.Codec<A, I>) {
  const same = Schema.toEquivalence(schema), encode = Schema.encodeSync(schema), decode = Schema.decodeUnknownSync(schema);
  return (value: A) => same(decode(encode(value)), value);
}

/** Encoding is stable: a value that went through its encoding and back encodes as it did before. */
export function encodesStably<A, I>(schema: Schema.Codec<A, I>) {
  const encode = Schema.encodeSync(schema), decode = Schema.decodeUnknownSync(schema);
  return (value: A) => { const once = encode(value); return Equal.equals(encode(decode(once)), once); };
}

/** Applying `f` twice is applying it once. */
export const idempotent = <A>(f: (input: A) => A) => (input: A) => { const once = f(input); return Equal.equals(f(once), once); };

/** `f` gives equal outputs for the same input. */
export const deterministic = <A, B>(f: (input: A) => B) => (input: A) => Equal.equals(f(input), f(input));

/** `rule` holds of every input and what `f` makes of it. */
export const invariant = <A, B>(f: (input: A) => B, rule: (input: A, output: B) => boolean) => (input: A) => rule(input, f(input));

/** `back` undoes `f`. */
export const inverse = <A, B>(f: (input: A) => B, back: (output: B) => A) => (input: A) => Equal.equals(back(f(input)), input);

/** What a `*.contract.ts` module says of one function: its inputs and the properties that must hold of it. */
export interface Contract<A, B> {
  input: Source<A>;
  run: (input: A) => B;
  deterministic?: boolean;
  /** Only where `run` returns what it takes. */
  idempotent?: boolean;
  invariant?: (input: A, output: B) => boolean;
  inverse?: (output: B) => A;
}

const CONTRACT = "~vibestack/testing/Contract";
export const contract = <A, B>(declared: Contract<A, B>) => ({ ...declared, [CONTRACT]: true }) as Contract<A, B>;
export const isContract = (u: unknown): u is Contract<any, any> => typeof u === "object" && u !== null && CONTRACT in u;

/** The properties `c` declares, by name: generate.ts writes one `contractTest` for each. */
export const declared = <A, B>(c: Contract<A, B>): Record<string, ((input: A) => boolean) | undefined> => ({
  deterministic: c.deterministic ? deterministic(c.run) : undefined,
  idempotent: c.idempotent ? idempotent(c.run as unknown as (input: A) => A) : undefined,
  invariant: c.invariant && invariant(c.run, c.invariant),
  inverse: c.inverse && inverse(c.run, c.inverse),
});

export function contractTest<A, B>(name: string, c: Contract<A, B>, property: string) {
  it.effect(`${name} is ${property}`, () => holds(c.input, declared(c)[property] ?? (() => { throw new Error(`${name} declares no ${property} property`); })));
}

export function schemaTests<A, I>(name: string, schema: Schema.Codec<A, I>) {
  it.effect(`${name}: decoding what was encoded gives the value back`, () => holds(schema, roundTrips(schema)));
  it.effect(`${name}: encoding is stable`, () => holds(schema, encodesStably(schema)));
}
