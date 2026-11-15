// spec/app/index.md, "Story: Say hello"
import { Alert, Button, Input } from "@repo/ui";
import { Cause, Exit, type ManagedRuntime } from "effect";
import { useEffect, useRef, useState } from "react";
import type { Greeted, Machine } from "../gen/app.effect.vibe";
import { useMachine } from "../gen/app.react.ts";
import { linked, typed } from "./greeter.vibe";
import { greeting } from "./greeting.ts";
import { linkTo, nameIn } from "./link.ts";

export interface AppProps {
  /** Provides the greeter: `greeter` of greeter.vibe over a store. */
  runtime: ManagedRuntime.ManagedRuntime<Machine, unknown>;
  /** The query of the address the page was opened with, which may carry a name to greet (link.ts). */
  search: string;
}

/**
 * The greeter: Greet is offered exactly when the rules allow greeting the name typed, a link greets the name it
 * carries, and each greeting is said to a screen reader as the spec's `out` says it.
 * @model spec/app/index.md
 */
export function App({ runtime, search }: AppProps) {
  const { state, cause, can } = useMachine(runtime);
  const [name, setName] = useState("");
  /** What the last event did: what the rules had the page say, or why it failed. */
  const [last, setLast] = useState<Exit.Exit<Greeted, unknown>>();
  const nameRef = useRef<HTMLInputElement>(null);

  // A reload of the same link is refused by the rules, and so is StrictMode's second run of this effect.
  useEffect(() => {
    const carried = nameIn(search);
    if (carried) void runtime.runPromiseExit(linked({ type: "greet", name: carried })).then(setLast);
  }, [runtime, search]);

  if (cause) return <Alert variant="destructive" className="m-6">Cannot read the saved greeter</Alert>;
  if (!state) return null;

  const submit = async () => {
    const exit = await runtime.runPromiseExit(typed({ type: "greet", name }));
    setLast(exit);
    if (Exit.isFailure(exit)) return;
    setName("");
    nameRef.current?.focus();
  };

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">{greeting(state)}</h1>
      {state.count > 0 && <a className="text-sm text-muted-foreground underline" href={linkTo(state.name)}>Link that greets {state.name}</a>}
      <output aria-label="Greetings" className="text-5xl font-semibold tabular-nums">{state.count}</output>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Input ref={nameRef} aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" disabled={!can({ type: "greet", name }, "Typed")}>Greet</Button>
      </form>
      <p role="status" className="sr-only">{last && Exit.isSuccess(last) && last.value.out.map((hello) => `Hello, ${hello.to}!`).join(" ")}</p>
      {last && Exit.isFailure(last) && Cause.hasDies(last.cause) && <Alert variant="destructive">Not saved</Alert>}
    </main>
  );
}
