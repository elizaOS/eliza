// spec/inbox/backgroundNotices.md, "Story: Open the Inbox or ask about the exact notification I tapped"; spec/inbox/backgroundNotices.md, "A pending tap opens only the current grant and ordinary opening spends it first"; spec/inbox/backgroundNotices.md, "Ask rechecks the exact reviewed subject and snippet before consumption"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/inbox__backgroundNotices.conformance.ts";
import type { NoticeTap } from "../../gen/inbox__backgroundNotices.ts";
import { noticeTapSession, type NoticeTapSession } from "@elizaos/plugin-inbox-client";

const taps = new Map<string, NoticeTapSession>();

const tapFor = (key: string): NoticeTapSession => {
  const found = taps.get(key);
  if (found) return found;
  const made = Effect.runSync(noticeTapSession());
  taps.set(key, made);
  return made;
};

export const driver: Driver<NoticeTap> = {
  reset: () => { taps.clear(); },
  dispatch: (key, event) => Effect.runSync(tapFor(key).step(event)) === undefined ? "refused" : "accepted",
  observe: (key) => Effect.runSync(tapFor(key).state()),
};

export const options: Options<NoticeTap> = { keys: ["tap-a", "tap-b"] };
