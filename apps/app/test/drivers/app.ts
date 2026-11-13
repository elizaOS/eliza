// SPEC.md, "Conformance": spec/app/index.md against the shell of src/greeter.vibe, observed as what its store holds,
// and its effects as what the last event said.
import { Effect, Layer } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { effectDriver } from "vibestack/testing";
import type { Options } from "../../gen/app.conformance.ts";
import type { Machine } from "../../gen/app.effect.vibe";
import type { Event, Greeted, Greeter } from "../../gen/app.ts";
import { greeter, linked, typed } from "../../src/greeter.vibe";

let said: Greeted["out"] = [];
const refused = () => Effect.sync(() => { said = []; return "refused" as const; });
/** What the shell did with `input` from `by`: a refusal by the rules or the decoder is "refused", any other failure stays one. */
const receive = (_key: string, input: unknown, by?: unknown) =>
  (by === "Linked" ? linked : typed)(input).pipe(
    Effect.map(({ out }) => { said = out; return "accepted" as const; }),
    Effect.catchTags({ Rejected: refused, NotAnEvent: refused }),
  );

/** The greeter as stored; nothing is stored until someone is greeted. */
const observe = () => Effect.map(KeyValueStore.KeyValueStore.use((store) => store.get("greeter")), (found) => found === undefined ? null : JSON.parse(found) as Greeter);

export const driver = effectDriver<Event, Greeter | null, Machine | KeyValueStore.KeyValueStore, unknown>(
  Layer.provideMerge(greeter, KeyValueStore.layerMemory),
  { dispatch: receive, receive, observe, observeOutput: () => Effect.succeed(said) },
);

/** One greeter, so one key; the initial greeter is the empty store. */
export const options: Options<Greeter | null> = { keys: ["greeter"], view: (g) => g.count === 0 ? null : g };
