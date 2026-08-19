/**
 * G1 mid-conversation supersession. The owner retracts one item from the
 * overdue backlog and substitutes another after drafting has begun. The
 * retraction must remove the item from the working set rather than leaving a
 * stale draft behind it: an apology for a thread the owner already answered is
 * worse than no apology at all.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "g1-backlog-correction-supersedes",
  title: "Retracted backlog item supersedes rather than stacks",
  domain: "lifeops.relationships",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "G1",
    "overdue-comms",
    "supersession",
    "self-contradiction",
    "backlog",
  ],
  tier: "T3",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "G1 Backlog Correction",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner-lists-backlog",
      room: "main",
      text: "i'm behind on three replies - the invoice question from priya, the intro request from tomas, and the venue quote. can you line up short apology replies for all of them?",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The owner named three overdue replies: Priya's invoice question, Tomas's intro request, and the venue quote. Grade PASS only if the assistant stages short reviewable drafts for those three and keeps them unsent pending approval. It fails if it claims any reply was sent, invents additional overdue threads, or fabricates commitments or deadlines the owner never gave.",
      },
    },
    {
      kind: "message",
      name: "owner-retracts-and-substitutes",
      room: "main",
      text: "actually scratch priya, i answered her friday and forgot. it's the landlord one i haven't touched.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner RETRACTED the Priya item (already answered on Friday) and substituted a landlord thread. Grade PASS only if the working set becomes exactly three items - Tomas, the venue quote, and the landlord - with the Priya draft dropped, not merely deprioritized or left standing alongside the new one. It fails if a Priya apology remains in the set, if the assistant produces four items, if it asks the owner to re-confirm items that were never in question, or if it apologizes to Priya for a delay that did not happen.",
      },
    },
    {
      kind: "message",
      name: "owner-checks-state",
      room: "main",
      text: "ok so what's queued up right now",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner is asking for the current queue. Grade PASS only if the assistant reports exactly the three live drafts (Tomas, venue quote, landlord), explicitly excludes Priya, and states plainly that none of them have been sent. It fails if Priya appears in the queue, if the count is wrong, or if it claims or implies anything was already delivered.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "supersession-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "messageDelivered",
      name: "no-outbound-delivery-during-revision",
      expected: false,
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 3,
    },
    {
      type: "judgeRubric",
      name: "g1-backlog-correction-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the owner's retraction removed the already-answered thread from the backlog and the substitute took its place, leaving exactly three live drafts with no stale apology surviving, and nothing was sent.",
    },
  ],
});
