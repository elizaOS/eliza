// spec/core/unicode.md, "Byte counting combines surrogate pairs and replaces unpaired surrogates"; spec/core/unicode.md, "Prefix and suffix boundaries cannot introduce a split surrogate pair"
import { Arbitrary, Schema } from "effect";
import { contract } from "vibestack/testing";
import { tailWellFormed, toWellFormedUnicode, truncateWellFormed, utf8ByteLength } from "./unicode.vibe";

const units = Arbitrary.array(Arbitrary.schema(Schema.Literals(["a", "\u00e9", "\u20ac", "\uD83D", "\uDE00", "\uD83D\uDE00", "\u0000"])));
const text = Arbitrary.all([Arbitrary.schema(Schema.String), units]).pipe(Arbitrary.map(([raw, parts]) => raw + parts.join("")));
const cut = Arbitrary.all({ text, length: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 }))) });

export const bytesAreTheEncodedLength = contract({
  input: text,
  run: utf8ByteLength,
  deterministic: true,
  invariant: (input, bytes) => bytes === new TextEncoder().encode(input).length,
});

export const sanitationKeepsWellFormedText = contract({
  input: text,
  run: toWellFormedUnicode,
  idempotent: true,
  invariant: (input, output) => output.isWellFormed() && (!input.isWellFormed() || output === input),
});

export const prefixesStayWithinTheText = contract({
  input: cut,
  run: ({ text, length }) => truncateWellFormed(text, length),
  deterministic: true,
  invariant: ({ text, length }, prefix) => text.startsWith(prefix) && prefix.length <= length && (!text.isWellFormed() || prefix.isWellFormed()),
});

export const suffixesStayWithinTheText = contract({
  input: cut,
  run: ({ text, length }) => tailWellFormed(text, length),
  deterministic: true,
  invariant: ({ text, length }, suffix) => text.endsWith(suffix) && suffix.length <= length && (!text.isWellFormed() || suffix.isWellFormed()),
});
