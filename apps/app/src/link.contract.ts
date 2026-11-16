// What link.ts promises, checked by the tests `pnpm test` derives: a link carries back any name a person can type,
// which is any well-formed string.
import { Arbitrary, Schema } from "effect";
import { contract } from "vibestack/testing";
import { linkTo, nameIn } from "./link.ts";

const typable = Arbitrary.schema(Schema.String).pipe(Arbitrary.map((s) => s.toWellFormed()));

export const aLinkCarriesItsName = contract({ input: typable, run: linkTo, inverse: nameIn, deterministic: true });
