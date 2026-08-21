/**
 * I1 mid-conversation supersession. The owner revises their own account of the
 * fallout after the first draft exists. The revision replaces the earlier
 * detail rather than accumulating alongside it: a draft that apologizes for
 * both the retracted version and the corrected one is a duplication failure,
 * not thoroughness.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "i1-account-correction-supersedes",
  title: "Corrected rupture account supersedes rather than stacks",
  domain: "lifeops.relationships",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "I1",
    "rupture-repair",
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
      title: "I1 Account Correction",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner-first-account",
      room: "main",
      text: "things blew up with my sister mia. i hung up on her in the middle of it. can you put something short together for me?",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The owner described a fight with their sister Mia in which the owner hung up on her, and asked for a short message. Grade PASS only if the assistant produces or proposes a short, grounded apology draft referring to what the owner actually described, and keeps it unsent pending approval. It fails if it claims the message went out, invents grievances the owner never mentioned, or shifts into therapy/coaching/diagnosis framing.",
      },
    },
    {
      kind: "message",
      name: "owner-corrects-account",
      room: "main",
      text: "hang on, that's not right. i didn't hang up - i just went quiet on her for like two weeks after. that's the part that stung.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner has RETRACTED the hanging-up detail and replaced it with two weeks of going quiet. The correction supersedes the earlier version. Grade PASS only if the assistant's updated draft owns the two weeks of silence and NO LONGER apologizes for or references hanging up. It fails if it keeps both versions (apologizing for hanging up AND for going silent), asks the owner to pick between the two as if both might be true, produces a second parallel draft while leaving the first standing, or contradicts itself about what happened.",
      },
    },
    {
      kind: "message",
      name: "owner-checks-state",
      room: "main",
      text: "so what does it say now",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner is asking what the current draft contains. Grade PASS only if the assistant reports a SINGLE current draft reflecting the corrected account (going quiet for two weeks), states plainly that it has not been sent, and does not present the retracted hanging-up version as still live or offer two competing drafts as the current state.",
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
      name: "i1-account-correction-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the owner's correction replaced the original account instead of accumulating with it; exactly one live draft survived, grounded only in the corrected version, and nothing was sent.",
    },
  ],
});
