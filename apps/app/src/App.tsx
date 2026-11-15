// spec/app/index.md, "Story: Say hello"
import { Alert, Button, Input } from "@repo/ui";
import { Cause, Exit, type ManagedRuntime } from "effect";
import { useRef, useState } from "react";
import type { Machine } from "../gen/app.effect.vibe";
import { useMachine } from "../gen/app.react.ts";
import { greeting } from "./greeting.ts";

/**
 * The greeter: Greet is offered exactly when the rules allow greeting the name typed.
 * @model spec/app/index.md
 */
export function App({ runtime }: { runtime: ManagedRuntime.ManagedRuntime<Machine, unknown> }) {
  const { state, cause, can, send } = useMachine(runtime);
  const [name, setName] = useState("");
  const [unsaved, setUnsaved] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  if (cause) return <Alert variant="destructive" className="m-6">Cannot read the saved greeter</Alert>;
  if (!state) return null;

  const greet = async () => {
    const exit = await send({ type: "greet", name });
    // The store not taking the greeter dies (gen/app.effect.vibe, `stored`); a refusal by the rules is a failure.
    setUnsaved(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    if (Exit.isFailure(exit)) return;
    setName("");
    nameRef.current?.focus();
  };

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">{greeting(state)}</h1>
      <output aria-label="Greetings" className="text-5xl font-semibold tabular-nums">{state.count}</output>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void greet(); }}>
        <Input ref={nameRef} aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" disabled={!can({ type: "greet", name })}>Greet</Button>
      </form>
      {unsaved && <Alert variant="destructive">Not saved</Alert>}
    </main>
  );
}
