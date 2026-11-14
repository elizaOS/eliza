// The fixture's application: lamps by key, each with a fuse that blows on the fourth switch. A switch settles after a second.
import { Context, Data, Effect, Layer } from "effect";

export interface Lamp { mode: "On" | "Off"; flips: number }
export class Blown extends Data.TaggedError("Blown")<{ key: string }> {}

export class Lamps extends Context.Service<Lamps, {
  toggle(key: string): Effect.Effect<Lamp, Blown>;
  get(key: string): Effect.Effect<Lamp>;
}>()("Lamps") {}

export const lamps = Layer.sync(Lamps, () => {
  const all = new Map<string, Lamp>();
  const get = (key: string) => all.get(key) ?? { mode: "Off", flips: 0 };
  return {
    get: (key) => Effect.sync(() => get(key)),
    toggle: (key) => Effect.gen(function* () {
      const lamp = get(key);
      if (lamp.flips >= 3) return yield* new Blown({ key });
      yield* Effect.sleep("1 second");
      const next: Lamp = { mode: lamp.mode === "On" ? "Off" : "On", flips: lamp.flips + 1 };
      all.set(key, next);
      return next;
    }),
  };
});
