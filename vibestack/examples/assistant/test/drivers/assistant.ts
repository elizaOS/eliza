// How `pnpm check` reaches the durable assistant to compare it with spec/assistant.md (SPEC.md, "Conformance"): every
// journey, malformed inputs and random walks through the machine kept in a real file, each trace with a fresh file. An
// accepted restart is a real one: the machine is dropped and opened again from its file
// (spec/assistant.md, "Story: Survive a restart").
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import type { Driver, Options } from "../../gen/assistant.conformance.ts";
import type { Actor, Chosen } from "../../gen/assistant.ts";
import { opened } from "../../src/durable.vibe";

const directory = mkdtempSync(join(tmpdir(), "assistant-"));
const file = join(directory, "assistant.json");
const node = ManagedRuntime.make(NodeServices.layer);
const open = () => node.runPromise(opened(file));
let machine = await open();
let out: unknown = [];

/** What the machine did with an event, and what it output; a refusal by the rules or the decoder outputs nothing. */
async function outcome(send: Effect.Effect<Chosen, { _tag: string }>, restart: boolean) {
  const refused = () => Effect.succeed({ did: "refused" as const, out: [] });
  const done = await node.runPromise(send.pipe(
    Effect.map((chosen) => ({ did: "accepted" as const, out: chosen.out })),
    Effect.catchTags({ Rejected: refused, NotAnEvent: refused }),
  ));
  out = done.out;
  if (done.did === "accepted" && restart) machine = await open();
  return done.did;
}

// `by` is one of the spec's senders: the check sends no other (vibestack's conformance.ts, `transition`).
export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    rmSync(file, { force: true });
    machine = await open();
  },
  dispatch: (_key, event, by) => outcome(machine.send(event, by as Actor), event.type === "restart"),
  receive: (_key, raw, by) => outcome(machine.receive(raw, by as Actor), (raw as { type?: unknown }).type === "restart"),
  observe: () => node.runPromise(machine.get()),
  observeOutput: () => out,
  [Symbol.asyncDispose]: async () => {
    await node.dispose();
    rmSync(directory, { recursive: true, force: true });
  },
};

/** One assistant, so one key; a write to disk per event keeps the walks few. */
export const options: Options = { keys: ["assistant"], walks: 50 };
