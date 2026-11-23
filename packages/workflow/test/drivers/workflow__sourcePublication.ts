// spec/workflow/sourcePublication.md, "Story: Import only complete reviewed workflow source"
import { Effect } from "effect";
import type { Driver } from "../../gen/workflow__sourcePublication.conformance.ts";
import type { Event } from "../../gen/workflow__sourcePublication.ts";
import { sourcePublication } from "../../src/worker/source.vibe";
import { outcome } from "../support/service.ts";

type Publication = Effect.Success<ReturnType<typeof sourcePublication>>;
const publications = new Map<string, Publication>();

async function publication(key: string): Promise<Publication> {
  const found = publications.get(key);
  if (found !== undefined) return found;
  const made = await Effect.runPromise(sourcePublication());
  publications.set(key, made);
  return made;
}

export const driver: Driver = {
  reset() {
    publications.clear();
  },
  async dispatch(key: string, event: Event) {
    return outcome((await publication(key)).send(event));
  },
  async observe(key: string) {
    return Effect.runPromise((await publication(key)).get());
  },
};

export const options = { keys: ["a", "b"] };
