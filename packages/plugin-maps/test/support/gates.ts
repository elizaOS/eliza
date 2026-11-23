// spec/maps/navigation.md, "Story: Plan directions and keep me in control of guidance"
import { Deferred, Effect, type Exit } from "effect";

export interface Gate<A, E> {
  readonly wait: Effect.Effect<A, E>;
  open(value: Exit.Exit<A, E>): Promise<void>;
}

export function gate<A, E = never>(): Gate<A, E> {
  const held = Effect.runSync(Deferred.make<A, E>());
  return { wait: Deferred.await(held), open: (value) => Effect.runPromise(Deferred.done(held, value)).then(() => undefined) };
}

export async function until(check: () => boolean | Promise<boolean>, tries = 200): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (await check()) return true;
    await Effect.runPromise(Effect.sleep(1));
  }
  return false;
}
