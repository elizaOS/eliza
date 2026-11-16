// spec/core/diagnostics.md, "Story: Redact untrusted diagnostic fields at the sink"; spec/core/diagnostics.md, "A credential field emits only a replacement marker"
import { Arbitrary, Schema } from "effect";
import { contract } from "vibestack/testing";
import { MIN_SECRET_LENGTH, redactSecrets } from "./redact.vibe";

const secretCharacter = Arbitrary.schema(Schema.Literals([..."abcdefghijklmnopqrstuvwxyz0123456789"]));
const secretLike = (minLength: number) =>
  Arbitrary.array(secretCharacter, { minLength, maxLength: minLength + 32 }).pipe(Arbitrary.map((characters) => characters.join("")));
const piece = Arbitrary.all([Arbitrary.schema(Schema.String), secretLike(0)]).pipe(Arbitrary.map((parts) => parts.join("")));
const leak = Arbitrary.all({
  secret: secretLike(MIN_SECRET_LENGTH),
  pieces: Arbitrary.array(piece, { minLength: 2, maxLength: 8 }),
});

export const anInsertedSecretNeverSurvivesRedaction = contract({
  input: leak,
  run: ({ secret, pieces }: { secret: string; pieces: string[] }) => redactSecrets(pieces.join(secret), { k: secret }),
  deterministic: true,
  invariant: ({ secret }, redacted) => !redacted.includes(secret),
});
