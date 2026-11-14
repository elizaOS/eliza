// SPEC.md, "Conformance": spec/app/index.md against the shell of src/greeter.vibe, observed as what its store holds.
import { Effect, Layer } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { effectDriver } from "vibestack/testing";
import type { Options } from "../../gen/app.conformance.ts";
import type { Event, Greeter } from "../../gen/app.ts";
import { Greetings, load, stored } from "../../src/greeter.vibe";

const refused = () => Effect.succeed("refused" as const);
/** What the shell did with `input`: a refusal by the rules or the decoder is "refused", any other failure stays one. */
const receive = (_key: string, input: unknown) =>
  Greetings.use((g) => g.receive(input)).pipe(Effect.as("accepted" as const), Effect.catchTags({ Rejected: refused, NotAnEvent: refused }));

export const driver = effectDriver<Event, Greeter, Greetings | KeyValueStore.KeyValueStore, never>(Layer.provideMerge(stored, KeyValueStore.layerMemory), { dispatch: receive, receive, observe: () => load() });

/** One greeter, so one key. */
export const options: Options = { keys: ["greeter"] };
