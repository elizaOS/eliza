/**
 * K1 approval gate. A supportive friend response is staged as a draft and the
 * scenario proves no external connector delivered it before owner approval.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "k1.third_party_support.owner_approval_before_send",
  title: "K1 supportive friend draft waits for owner approval",
  domain: "lifeops.relationships",
  tags: ["lifeops", "K1", "third-party-support", "approval", "message-draft"],
  isolation: "per-scenario",
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  turns: [
    {
      kind: "action",
      name: "stage-supportive-draft",
      room: "main",
      actionName: "MESSAGE",
      text: "Draft a supportive Signal reply to Zane and hold it for my approval.",
      options: {
        action: "draft_reply",
        recipient: "Zane Turner",
        channel: "signal",
        requiresConfirmation: true,
        body: "I'm sorry things have been heavy. I'm here with you, and I can sit with you for the first ten minutes if that helps.",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "MESSAGE",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: "MESSAGE",
      includesAll: ["draft_reply", "requiresConfirmation", "Zane Turner"],
    },
    {
      type: "custom",
      name: "no delivered external send",
      predicate: expectNoExternalSendDispatch(),
    },
  ],
});
