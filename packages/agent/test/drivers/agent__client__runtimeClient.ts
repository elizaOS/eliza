// spec/agent/client/runtimeClient.md, "Story: Call the runtime for my current account"; spec/agent/client/runtimeClient.md, "Story: Reach a runtime that is not running yet"; spec/agent/client/runtimeClient.md, "Story: Understand why the runtime refused"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/agent__client__runtimeClient.conformance.ts";
import type { BridgeCall, RuntimeClient, Stage } from "../../gen/agent__client__runtimeClient.ts";
import { createRuntimeCoordinator } from "../../src/client/coordination.vibe";

type Coordinator = Effect.Success<ReturnType<typeof createRuntimeCoordinator>>;

interface Held {
  readonly coordinator: Coordinator;
  readonly settled: Set<number>;
  out: BridgeCall[];
}

const waiting = (stage: Stage): boolean =>
  stage.tag === "AwaitRefresh" || stage.tag === "Probing" || stage.tag === "AwaitStartup" || stage.tag === "Sent";

const unsettled = (state: RuntimeClient): RuntimeClient => ({ ...state, requests: state.requests.filter(({ stage }) => waiting(stage)) });

const held = new Map<string, Held>();

const heldFor = (key: string): Held => {
  const found = held.get(key);
  if (found) return found;
  const made: Held = { coordinator: Effect.runSync(createRuntimeCoordinator()), settled: new Set(), out: [] };
  held.set(key, made);
  return made;
};

export const driver: Driver<RuntimeClient> = {
  reset: () => { held.clear(); },
  dispatch: (key, event) => {
    const client = heldFor(key);
    client.out = [];
    if (event.type === "release") return client.settled.delete(event.id) ? "accepted" : "refused";
    const update = Effect.runSync(client.coordinator.advance(event));
    if (!update) return "refused";
    for (const command of update.commands) {
      if (command.tag === "Finish") client.settled.add(command.id);
      else if (command.tag !== "Probe") client.out.push(command);
    }
    return "accepted";
  },
  observe: (key) => Effect.runSync(heldFor(key).coordinator.current()),
  observeOutput: (key) => heldFor(key).out,
};

export const options: Options<RuntimeClient> = { view: unsettled, keys: ["a"] };
