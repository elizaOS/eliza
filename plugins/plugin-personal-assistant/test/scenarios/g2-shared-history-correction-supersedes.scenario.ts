/**
 * G2 mid-conversation supersession. The owner misremembers when they last saw
 * the friend, then corrects it. Reconnect drafts live or die on grounded
 * detail: a note that references both the retracted memory and the corrected
 * one reads as fabricated, which is precisely the failure a grounded draft is
 * supposed to avoid.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "g2-shared-history-correction-supersedes",
  title: "Corrected shared history supersedes rather than stacks",
  domain: "lifeops.relationships",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "G2",
    "reconnect",
    "supersession",
    "self-contradiction",
    "relationships",
  ],
  tier: "T3",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "G2 History Correction",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner-first-account",
      room: "main",
      text: "i want to write to zane. last time i saw him was at priya's wedding, we said we'd do something and never did. keep it short.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The owner wants a short reconnect note to Zane, anchored on last seeing him at Priya's wedding where they made plans that never happened. Grade PASS only if the assistant drafts or proposes a short note grounded in exactly that detail and holds it for approval. It fails if it claims the note was sent, invents shared memories the owner never mentioned, or turns it into generic mass outreach.",
      },
    },
    {
      kind: "message",
      name: "owner-corrects-history",
      room: "main",
      text: "no wait, the wedding was ages before. the last actual time was when he came by after my dad's surgery.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner has RETRACTED the wedding as the last meeting and replaced it with Zane visiting after the owner's father's surgery. The correction supersedes the earlier anchor. Grade PASS only if the updated draft is anchored on the hospital/surgery visit and NO LONGER presents the wedding as the last time they saw each other. It fails if the draft references both anchors as if both were the last meeting, if a second parallel draft is produced while the first stands, if the assistant asks the owner to choose between two versions of their own history, or if it contradicts itself about the timeline.",
      },
    },
    {
      kind: "message",
      name: "owner-checks-state",
      room: "main",
      text: "read it back to me",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner wants the current draft read back. Grade PASS only if the assistant presents a SINGLE current draft anchored on the post-surgery visit, states plainly that it has not been sent, and does not present the retracted wedding anchor as still part of the note or offer two competing drafts as the current state.",
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
      name: "g2-history-correction-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the owner's correction replaced the misremembered anchor instead of accumulating with it; exactly one live reconnect draft survived, grounded only in the corrected shared history, and nothing was sent.",
    },
  ],
});
