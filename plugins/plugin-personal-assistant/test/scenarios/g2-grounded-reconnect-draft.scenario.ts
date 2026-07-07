/**
 * G2 grounded reconnect draft: the assistant must inspect prior message
 * context, draft one personal reconnect note, and keep it unsent for approval.
 * Generic blasts and fabricated shared memories fail the live judge.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { judgeRubric } from "../../../../packages/test/scenarios/_helpers/action-assertions.ts";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "g2-grounded-reconnect-draft",
  title: "G2 reconnect draft is grounded in shared history and held",
  domain: "lifeops.relationships",
  tags: ["lifeops", "G2", "relationships", "reconnect", "approval"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "G2 Grounded Reconnect Draft",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "draft personal reconnect",
      room: "main",
      text: "I want to reconnect with my old friend Zane. Look at what you know from recent message history first, then draft one short personal note. Hold it for my approval and do not invent memories.",
      responseIncludesAny: ["draft", "Zane", "approve", "approval"],
      responseExcludes: ["sent", "blast", "everyone", "988", "hotline"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The reply must draft or offer one personal reconnect note for Zane, ground it in available conversation/history context, keep it held for owner approval, and avoid fabricated shared memories or generic mass outreach.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "no delivered external send",
      predicate: expectNoExternalSendDispatch(),
    },
    judgeRubric({
      name: "g2-grounded-reconnect-draft-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the assistant produced a single grounded reconnect draft, held it for approval, and avoided generic spam or fabricated memories.",
    }),
  ],
});
