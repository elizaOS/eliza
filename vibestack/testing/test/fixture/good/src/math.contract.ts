// A fixture package's contracts: generate.ts writes one test for each property declared here.
import { Arbitrary, Schema } from "effect";
import { contract } from "../../../../index.ts";

export const clamp = (n: number) => Math.min(10, Math.max(0, n));
export const clamped = contract({ input: Schema.Int, run: clamp, deterministic: true, idempotent: true, invariant: (_, out) => 0 <= out && out <= 10 });

const even = Arbitrary.schema(Schema.Int).pipe(Arbitrary.map((n) => n * 2));
export const halved = contract({ input: even, run: (n) => n / 2, inverse: (half) => half * 2 });

export const undeclared = contract({ input: Schema.Int, run: clamp });
