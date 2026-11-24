// spec/inbox/readState.md, "Story: Change a message's read state once, and never repeat a change I did not ask for"; spec/inbox/readState.md, "One change per message is in flight, and an unconfirmed automatic change is not sent again"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/inbox__readState.conformance.ts";
import type { ReadStateView } from "../../gen/inbox__readState.ts";
import { mailReadStateGuard, type MailReadStateGuard } from "@elizaos/plugin-inbox-client";

const guards = new Map<string, MailReadStateGuard>();

const guardFor = (key: string): MailReadStateGuard => {
  const found = guards.get(key);
  if (found) return found;
  const made = Effect.runSync(mailReadStateGuard());
  guards.set(key, made);
  return made;
};

export const driver: Driver<ReadStateView> = {
  reset: () => { guards.clear(); },
  dispatch: (key, event) => Effect.runSync(guardFor(key).step(event)) === undefined ? "refused" : "accepted",
  observe: (key) => Effect.runSync(guardFor(key).state()),
};

export const options: Options<ReadStateView> = { keys: ["view-a", "view-b"] };
