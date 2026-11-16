// spec/core/protocols.md, "A public value retains identity and explicitly declared version"
import { Arbitrary, Effect, Exit, Schema } from "effect";
import { contract } from "vibestack/testing";
import { stringToUuid } from "./string-to-uuid.vibe";
import { UUID_PATTERN, validateUuid } from "./uuid.vibe";

const hex = Arbitrary.schema(Schema.Literals(["0", "7", "9", "a", "b", "f", "A", "C", "F"]));
const hexRun = (length: number) => Arbitrary.array(hex, { minLength: length, maxLength: length }).pipe(Arbitrary.map((digits) => digits.join("")));
const uuidShaped = Arbitrary.all([hexRun(8), hexRun(4), hexRun(4), hexRun(4), hexRun(12)]).pipe(Arbitrary.map((groups) => groups.join("-")));
const typed = Arbitrary.schema(Schema.String).pipe(Arbitrary.map((text) => text.toWellFormed()));
const name = Arbitrary.all([typed, uuidShaped, Arbitrary.schema(Schema.Boolean)]).pipe(Arbitrary.map(([text, uuid, isUuid]) => (isUuid ? uuid : text)));

const uuidOf = (target: string) => {
  const exit = Effect.runSyncExit(stringToUuid(target));
  return Exit.isSuccess(exit) ? exit.value : null;
};

export const everyNameHasOneUuid = contract({
  input: name,
  run: uuidOf,
  deterministic: true,
  idempotent: true,
  invariant: (input, uuid) =>
    uuid !== null && UUID_PATTERN.test(uuid) && validateUuid(uuid) === uuid && (validateUuid(input) === null ? uuid === uuid.toLowerCase() : uuid === input),
});
