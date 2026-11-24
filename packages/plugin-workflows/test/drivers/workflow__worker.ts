// spec/workflow/worker.md, "Story: Run workflows from the reviewed source and signed device assets"
import { Effect } from "effect";
import type { Driver } from "../../gen/workflow__worker.conformance.ts";
import type { Event } from "../../gen/workflow__worker.ts";
import { workerProvenance } from "@elizaos/plugin-workflow-worker";
import { outcome } from "../support/service.ts";

type Provenance = Effect.Success<ReturnType<typeof workerProvenance>>;
const workers = new Map<string, Provenance>();

async function worker(key: string): Promise<Provenance> {
  const found = workers.get(key);
  if (found !== undefined) return found;
  const made = await Effect.runPromise(workerProvenance());
  workers.set(key, made);
  return made;
}

export const driver: Driver = {
  reset() {
    workers.clear();
  },
  async dispatch(key: string, event: Event) {
    return outcome((await worker(key)).step(event));
  },
  async observe(key: string) {
    return Effect.runPromise((await worker(key)).state);
  },
};

export const options = { keys: ["a", "b"] };
