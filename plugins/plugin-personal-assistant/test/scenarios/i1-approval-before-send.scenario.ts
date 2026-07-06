/**
 * I1 approval gate for interpersonal repair. The repair draft is represented as
 * a MESSAGE draft action with `requiresConfirmation`, and the outcome check
 * proves no external connector delivered anything.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "i1.rupture_repair.approval_before_send",
  title: "I1 repair draft requires approval before send",
  domain: "lifeops.relationships",
  tags: ["lifeops", "I1", "approval", "message-draft", "relationships"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "I1 Approval Gate",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "stage-repair-draft",
      room: "main",
      actionName: "MESSAGE",
      text: "Stage a repair note to Zane, but it must wait for my approval before sending.",
      options: {
        action: "draft_reply",
        recipient: "Zane Turner",
        channel: "signal",
        requiresConfirmation: true,
        body: "Sorry I got sharp about the missed coffee plan. I want to reset when you have bandwidth.",
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
