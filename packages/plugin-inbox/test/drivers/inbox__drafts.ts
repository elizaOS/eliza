// spec/inbox/drafts.md, "Story: Keep drafts recoverable across account switches and provider failures"; spec/inbox/drafts.md, "A provider request is bound to the current draft and reserves its one dispatch durably"; spec/inbox/drafts.md, "Recovery reads the recorded request and cannot resend it"; spec/inbox/drafts.md, "The owner may cancel a review that was never dispatched"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/inbox__drafts.conformance.ts";
import type { MailState } from "../../gen/inbox__drafts.ts";
import { journalModel, type JournalModel } from "@elizaos/plugin-inbox-client";

const journals = new Map<string, JournalModel>();

const journalFor = (key: string): JournalModel => {
  const found = journals.get(key);
  if (found) return found;
  const made = Effect.runSync(journalModel());
  journals.set(key, made);
  return made;
};

export const driver: Driver<MailState> = {
  reset: () => { journals.clear(); },
  dispatch: (key, event) => Effect.runSync(journalFor(key).step(event)) === undefined ? "refused" : "accepted",
  observe: (key) => Effect.runSync(journalFor(key).state()),
};

export const options: Options<MailState> = { keys: ["owner-grant-a", "owner-grant-b"] };
