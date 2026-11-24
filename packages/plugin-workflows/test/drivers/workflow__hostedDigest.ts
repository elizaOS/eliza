// spec/workflow/hostedDigest.md, "Story: Acknowledge a page of digests only after it is stored"
import { Effect } from "effect";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import type { Driver } from "../../gen/workflow__hostedDigest.conformance.ts";
import type { Event } from "../../gen/workflow__hostedDigest.ts";
import { digestInbox, type DigestInbox } from "@elizaos/plugin-workflow-client";
import { outcome } from "../support/service.ts";

const inboxes = new Map<string, DigestInbox>();
let generation = 0;

async function inbox(key: string): Promise<DigestInbox> {
  const found = inboxes.get(key);
  if (found !== undefined) return found;
  const made = await Effect.runPromise(Effect.provide(digestInbox(`conformance-${generation}-${key}`), KeyValueStore.layerMemory));
  inboxes.set(key, made);
  return made;
}

export const driver: Driver = {
  reset() {
    generation += 1;
    inboxes.clear();
  },
  async dispatch(key: string, event: Event) {
    return outcome((await inbox(key)).step(event));
  },
  async observe(key: string) {
    return Effect.runPromise((await inbox(key)).state);
  },
};

export const options = { keys: ["a", "b"] };
