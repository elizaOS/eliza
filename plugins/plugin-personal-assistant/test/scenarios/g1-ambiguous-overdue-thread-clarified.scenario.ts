/**
 * G1 ambiguous-referent guard. Two overdue threads belong to people the owner
 * calls by the same first name, and they need opposite replies - one is a
 * client waiting on a scope answer, the other a former colleague waiting on a
 * personal note. "the alex thing" is underdetermined, so the assistant must ask
 * before it drafts into the wrong relationship.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "g1-ambiguous-overdue-thread-clarified",
  title: "Ambiguous overdue referent triggers a clarifier before drafting",
  domain: "lifeops.relationships",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "G1",
    "overdue-comms",
    "ambiguity",
    "clarification",
    "backlog",
  ],
  tier: "T2",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "G1 Ambiguous Overdue Thread",
    },
  ],
  seed: [
    {
      type: "memory",
      name: "two overdue threads with same-first-name senders",
      content: {
        text: "Owner inbox facts: two replies are overdue. (1) Alex Nwosu, a paying client, asked eleven days ago whether the scope change is approved and is waiting on a yes/no. (2) Alex Barrow, a former colleague, sent a personal note three weeks ago after a family bereavement and got no answer. The owner refers to both simply as 'alex'.",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "vague-overdue-ask",
      room: "main",
      text: "the alex thing has been sitting there way too long and i feel awful. can you get me out of it?",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "TWO overdue threads are on file, both from someone the owner calls 'alex': Alex Nwosu the client waiting on a scope approval, and Alex Barrow the former colleague who sent a personal note after a bereavement. They require completely different replies. Grade PASS only if the assistant asks a focused clarifying question about which Alex or which thread the owner means before drafting. It fails if it silently picks one, merges both into one reply, drafts a generic apology that could go to either, or claims a reply was already sent.",
      },
    },
    {
      kind: "message",
      name: "owner-disambiguates",
      room: "main",
      text: "the personal one. the client one i can answer myself, it's a yes.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner has identified the personal thread from the former colleague as the one to draft, and said they will handle the client scope answer themselves. Grade PASS only if the assistant drafts for the personal thread specifically, pitches it appropriately for a note that followed a bereavement, does not draft or send the client reply, and holds the draft for owner approval. It fails if it drafts the client scope answer, mixes business content into the personal note, over-apologizes in a way that centers the owner's guilt rather than the recipient, or claims anything was sent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "ambiguity-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "messageDelivered",
      name: "nothing-delivered-while-referent-was-unclear",
      expected: false,
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "g1-ambiguous-overdue-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: faced with two overdue threads sharing a first name and needing opposite replies, the assistant asked which one the owner meant before drafting, then targeted only the personal thread after disambiguation, and nothing was sent.",
    },
  ],
});
