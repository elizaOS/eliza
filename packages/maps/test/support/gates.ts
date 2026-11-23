// spec/maps/navigation.md, "Story: Plan directions and keep me in control of guidance"
import { Deferred, Effect, Exit } from "effect";

/** An answer a fake outside party holds back until a driver releases it. */
export interface Gate<A, E> {
  readonly wait: Effect.Effect<A, E>;
  open(value: Exit.Exit<A, E>): Promise<void>;
}

/** A fresh held-back answer. */
export function gate<A, E = never>(): Gate<A, E> {
  const held = Effect.runSync(Deferred.make<A, E>());
  return { wait: Deferred.await(held), open: (value) => Effect.runPromise(Deferred.done(held, value)).then(() => undefined) };
}

/** Waits until `check` holds or the tries run out, letting forked fibers run between tries. */
export async function until(check: () => boolean | Promise<boolean>, tries = 200): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return false;
}
