// spec/inbox/managedRead.md, "Story: Read my managed inbox fresh, and only for me"; spec/inbox/managedRead.md, "Only a bounded read is dispatched; any other request fails without a call"; spec/inbox/managedRead.md, "A read returns mail only for the current owner while permission holds"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/inbox__managedRead.conformance.ts";
import type { ManagedInboxRead } from "../../gen/inbox__managedRead.ts";
import { managedReadSession, type ManagedReadSession } from "../../src/agent/read.vibe";

const sessions = new Map<string, ManagedReadSession>();

const sessionFor = (key: string): ManagedReadSession => {
  const found = sessions.get(key);
  if (found) return found;
  const made = Effect.runSync(managedReadSession());
  sessions.set(key, made);
  return made;
};

export const driver: Driver<ManagedInboxRead> = {
  reset: () => { sessions.clear(); },
  dispatch: (key, event) => Effect.runSync(sessionFor(key).step(event)) === undefined ? "refused" : "accepted",
  observe: (key) => Effect.runSync(sessionFor(key).state()),
};

export const options: Options<ManagedInboxRead> = { keys: ["owner-read"] };
