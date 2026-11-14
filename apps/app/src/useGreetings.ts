// .claude/skills/shell/SKILL.md, "The React interface": the greeter `Greetings` holds, and the events `enabled` allows, for a component.
import { Effect, type ManagedRuntime, Stream } from "effect";
import { useMemo, useSyncExternalStore } from "react";
import { type Event, type Greeter, enabled } from "../gen/app.ts";
import { Greetings } from "./greeter.vibe";

/** What `stored` of greeter.vibe provides, over any store. */
export type Runtime = ManagedRuntime.ManagedRuntime<Greetings, unknown>;

export function useGreetings(runtime: Runtime) {
  const store = useMemo(() => {
    let greeter: Greeter | undefined;
    return {
      get: () => greeter,
      subscribe: (notify: () => void) => {
        const fiber = runtime.runFork(Greetings.use((g) => Stream.runForEach(g.changes, (next) => Effect.sync(() => { greeter = next; notify(); }))));
        return () => fiber.interruptUnsafe();
      },
    };
  }, [runtime]);
  const greeter = useSyncExternalStore(store.subscribe, store.get);
  return {
    /** Undefined until the stored greeter has been read. */
    greeter,
    can: (event: Event) => greeter !== undefined && enabled(greeter, event),
    send: (event: Event) => runtime.runPromiseExit(Greetings.use((g) => g.receive(event))),
  };
}
