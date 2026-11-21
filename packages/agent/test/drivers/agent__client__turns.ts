// spec/agent/client/turns.md, "Story: Stop a reply without sending the next message against an uncertain room"; spec/agent/client/turns.md, "Story: Get the reply to my message even when the stream drops"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/agent__client__turns.conformance.ts";
import type { ClientCall, TurnClient } from "../../gen/agent__client__turns.ts";
import { advanceTurns, openTurnSession, type TurnSession } from "../../src/client/turn-controller.vibe";

const unreachable = () => Promise.reject(new Error("NoRoute"));

interface Held {
  readonly session: TurnSession;
  out: readonly ClientCall[];
}

const held = new Map<string, Held>();

const heldFor = (key: string): Held => {
  const found = held.get(key);
  if (found) return found;
  const made: Held = { session: openTurnSession({ request: unreachable, stream: unreachable }), out: [] };
  held.set(key, made);
  return made;
};

export const driver: Driver<TurnClient> = {
  reset: () => { held.clear(); },
  dispatch: (key, event) => {
    const client = heldFor(key);
    const step = Effect.runSync(advanceTurns(client.session, event));
    client.out = step?.out ?? [];
    return step === undefined ? "refused" : "accepted";
  },
  observe: (key) => Effect.runSync(heldFor(key).session.machine.get()),
  observeOutput: (key) => heldFor(key).out,
};

export const options: Options<TurnClient> = { keys: ["a", "b"] };
