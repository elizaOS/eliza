// A deliberately wrong function: its generated test must fail with the seed and the shrunk counterexample.
import { Schema } from "effect";
import { contract } from "../../../../index.ts";

export const absolute = contract({ input: Schema.Int, run: (n) => n, invariant: (_, out) => out >= 0 });
