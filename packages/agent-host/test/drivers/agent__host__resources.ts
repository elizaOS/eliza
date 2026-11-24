// spec/agent/host/resources.md, "Story: Release everything I acquired, once"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/agent__host__resources.conformance.ts";
import type { Event, Resources } from "../../gen/agent__host__resources.ts";
import { resources, type HeldResources, type ResourceName } from "../../src/host/resources.vibe";

interface Turn {
  readonly ok: () => void;
  readonly fail: (error: Error) => void;
}

interface Entity {
  readonly held: HeldResources;
  turn: Turn | undefined;
  closing: Promise<unknown> | undefined;
  settled: boolean;
}

const names: ReadonlySet<string> = new Set<ResourceName>(["store", "runtime", "plugins", "socket", "loopback"]);
const entities = new Map<string, Entity>();

function entity(key: string): Entity {
  const found = entities.get(key);
  if (found !== undefined) return found;
  const made: Entity = { held: resources(), turn: undefined, closing: undefined, settled: false };
  entities.set(key, made);
  return made;
}

function releaseFor(held: Entity): () => Promise<void> {
  return () => new Promise<void>((ok, fail) => {
    held.turn = { ok, fail };
  });
}

async function quiet(held: Entity): Promise<void> {
  while (held.turn === undefined && !held.settled) await Effect.runPromise(Effect.yieldNow);
}

function startClose(held: Entity): void {
  held.closing ??= held.held.close().then(
    () => { held.settled = true; },
    () => { held.settled = true; },
  );
}

export const driver: Driver = {
  reset() {
    entities.clear();
  },
  async dispatch(key, event: Event) {
    const held = entity(key);
    switch (event.type) {
      case "acquire":
        if (!names.has(event.resource)) throw new TypeError(`Unknown resource ${event.resource}`);
        try {
          held.held.acquire(event.resource as ResourceName, releaseFor(held));
          return "accepted";
        } catch (error) {
          if (error instanceof Error && error.name === "ResourcesClosed") return "refused";
          throw error;
        }
      case "close":
        startClose(held);
        await quiet(held);
        return "accepted";
      case "releaseNext": {
        const turn = held.turn;
        if (turn === undefined) return "refused";
        held.turn = undefined;
        if (event.ok) turn.ok();
        else turn.fail(new Error("The release failed"));
        await quiet(held);
        return "accepted";
      }
    }
  },
  observe(key): Resources {
    return entity(key).held.state();
  },
};

export const options: Options = { keys: ["process", "listener"] };
