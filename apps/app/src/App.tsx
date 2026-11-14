// spec/app/index.md, "Story: Say hello"
import { Alert, Button, Input } from "@repo/ui";
import { Cause, Exit } from "effect";
import { useRef, useState } from "react";
import { NotSaved } from "./greeter.vibe";
import { greeting } from "./greeting.ts";
import { type Runtime, useGreetings } from "./useGreetings.ts";

/**
 * The greeter: Greet is offered exactly when the rules allow greeting the name typed.
 * @model spec/app/index.md
 */
export function App({ runtime }: { runtime: Runtime }) {
  const { greeter, can, send } = useGreetings(runtime);
  const [name, setName] = useState("");
  const [unsaved, setUnsaved] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  if (!greeter) return null;

  const greet = async () => {
    const exit = await send({ type: "greet", name });
    setUnsaved(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof NotSaved);
    if (Exit.isFailure(exit)) return;
    setName("");
    nameRef.current?.focus();
  };

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">{greeting(greeter)}</h1>
      <output aria-label="Greetings" className="text-5xl font-semibold tabular-nums">{greeter.count}</output>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void greet(); }}>
        <Input ref={nameRef} aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" disabled={!can({ type: "greet", name })}>Greet</Button>
      </form>
      {unsaved && <Alert variant="destructive">Not saved</Alert>}
    </main>
  );
}
