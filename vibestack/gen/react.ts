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
    `import { useMemo, useSyncExternalStore } from "react";`,
    `import { type Event, Machine, enabled } from "./${name}.effect.vibe";`,
    ``,
    `type State = Parameters<typeof enabled>[0];`,
    ...(step[1] ? [`type By = Parameters<typeof enabled>[2];`] : []),
    ``,
    `/**`,
    ` * The Machine that \`runtime\` provides, for a component. \`state\` is undefined until the machine has given one, and`,
    ` * \`cause\` is why it gives none, or no more: a layer that could not be built, such as \`stored\` over what it cannot`,
    ` * read. \`can\` is \`enabled\` in that state, and \`send\` resolves with the Exit of the machine's \`send\`.`,
    ` */`,
    `export function useMachine<E>(runtime: ManagedRuntime.ManagedRuntime<Machine, E>) {`,
    `  const store = useMemo(() => {`,
    `    let seen: { readonly state?: State; readonly cause?: Cause.Cause<E> } = {};`,
    `    const show = (next: typeof seen, notify: () => void) => { seen = next; notify(); };`,
    `    return {`,
    `      get: () => seen,`,
    `      subscribe: (notify: () => void) => {`,
    `        const fiber = runtime.runFork(Machine.use((machine) => Stream.runForEach(machine.changes, (state) => Effect.sync(() => show({ state }, notify)))));`,
    `        fiber.addObserver((exit) => { if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) show({ ...seen, cause: exit.cause }, notify); });`,
    `        return () => fiber.interruptUnsafe();`,
    `      },`,
    `    };`,
    `  }, [runtime]);`,
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
