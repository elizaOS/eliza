// A fixture package's schemas: generate.ts derives the tests of properties.ts from each export.
import { Schema } from "effect";

/** A branded value. */
export const UserId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("UserId"));

/** A tagged union. */
export const Shape = Schema.Union([
  Schema.TaggedStruct("Circle", { radius: Schema.Finite }),
  Schema.TaggedStruct("Square", { side: Schema.Finite }),
]);

/** A recursive schema. */
export interface Tree { readonly label: string; readonly children: ReadonlyArray<Tree> }
export const Tree: Schema.Codec<Tree> = Schema.Struct({ label: Schema.String, children: Schema.Array(Schema.suspend(() => Tree)) });

/** A schema whose encoding differs from its type. */
export const User = Schema.Struct({ id: UserId, age: Schema.FiniteFromString, shape: Shape });

/** No value can be generated for a declaration that says nothing of its values: reported, never tested. */
export const Opaque = Schema.declare((u): u is WeakKey => typeof u === "object" && u !== null);

export const limit = 3;
