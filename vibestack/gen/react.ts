// The React face of a generated state machine: gen/<name>.react.ts beside gen/<name>.effect.vibe, in a package that
// depends on react (units.ts).
import { SENDER } from "./classify.ts";

/**
 * `text` is gen/<name>.ts. A state machine gets `useMachine`, the one bridge from its `Machine` service to a
 * component: the state as the service publishes it, and `enabled` and `send` for what the component offers. A
 * library gets nothing.
 */
export function reactHook(name: string, source: string, text: string): string | undefined {
  const step = text.match(new RegExp(`^export function step\\(current: .+?, event: Event(, ${SENDER}: .+?)?\\): `, "m"));
  if (!step) return undefined;
  const by = step[1] ? `, ${SENDER}: By` : "";
  const passed = step[1] ? `, ${SENDER}` : "";
  return [
    `// GENERATED from ${source} by vibestack/spec.ts. Do not edit: change the spec and run \`pnpm gen\`.`,
    `// gen/${name}.effect.vibe for React: the state of its Machine for a component, and the events the rules allow.`,
    `import { Cause, Effect, Exit, type ManagedRuntime, Stream } from "effect";`,
    `import { useSyncExternalStore } from "react";`,
    `import { type Event, Machine, enabled } from "./${name}.effect.vibe";`,
    ``,
    `type State = Parameters<typeof enabled>[0];`,
    ...(step[1] ? [`type By = Parameters<typeof enabled>[2];`] : []),
    ``,
    `type Snapshot<E> = { readonly state?: State; readonly cause?: Cause.Cause<E> };`,
    `type Store<E> = { get: () => Snapshot<E>; subscribe: (notify: () => void) => () => void };`,
    `const stores = new WeakMap<object, unknown>();`,
    ``,
    `function storeFor<E>(runtime: ManagedRuntime.ManagedRuntime<Machine, E>): Store<E> {`,
    `  const known = stores.get(runtime) as Store<E> | undefined;`,
    `  if (known) return known;`,
    `  let seen: Snapshot<E> = {};`,
    `  const listeners = new Set<() => void>();`,
    `  let active: object | undefined;`,
    `  let stop: (() => void) | undefined;`,
    `  const store: Store<E> = {`,
    `    get: () => seen,`,
    `    subscribe: (notify) => {`,
    `      listeners.add(notify);`,
    `      if (!active) {`,
    `        const token = {};`,
    `        active = token;`,
    `        const show = (next: Snapshot<E>) => {`,
    `          if (active !== token) return;`,
    `          seen = next;`,
    `          for (const listener of listeners) listener();`,
    `        };`,
    `        const fiber = runtime.runFork(Machine.use((machine) => Stream.runForEach(machine.changes, (state) => Effect.sync(() => show({ state })))));`,
    `        stop = () => fiber.interruptUnsafe();`,
    `        fiber.addObserver((exit) => { if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) show({ ...seen, cause: exit.cause }); });`,
    `      }`,
    `      return () => {`,
    `        listeners.delete(notify);`,
    `        if (!listeners.size) { active = undefined; stop?.(); stop = undefined; }`,
    `      };`,
    `    },`,
    `  };`,
    `  stores.set(runtime, store);`,
    `  return store;`,
    `}`,
    ``,
    `/**`,
    ` * The Machine that \`runtime\` provides, shared by its components. \`state\` is undefined until the machine has`,
    ` * given one, and \`cause\` is why it gives none or no more. The last subscriber releases the stream; a later`,
    ` * component immediately reads the last snapshot. \`send\` resolves with the Exit of the machine's \`send\`.`,
    ` */`,
    `export function useMachine<E>(runtime: ManagedRuntime.ManagedRuntime<Machine, E>) {`,
    `  const store = storeFor(runtime);`,
    `  const { state, cause } = useSyncExternalStore(store.subscribe, store.get, store.get);`,
    `  return {`,
    `    state,`,
    `    cause,`,
    `    can: (event: Event${by}) => state !== undefined && enabled(state, event${passed}),`,
    `    send: (event: Event${by}) => runtime.runPromiseExit(Machine.use((machine) => machine.send(event${passed}))),`,
    `  };`,
    `}`,
    ``,
  ].join("\n");
}
