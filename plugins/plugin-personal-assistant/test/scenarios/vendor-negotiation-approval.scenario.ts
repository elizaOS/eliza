// Defines the vendor negotiation approval LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * Asserts effects:
 *   - the counteroffer draft was materialized through a real messaging action
 *     whose captured arguments carry the negotiation content
 *     (`selectedActionArguments`), and NOTHING was dispatched on an external
 *     send channel — the draft-only gate held (negative outcome);
 *   - the Tuesday follow-up was captured as a scheduled item whose arguments
 *     carry the vendor follow-up (`selectedActionArguments` on the
 *     scheduling surface), not just a reply repeating "Tuesday".
 */
export default scenario({
  lane: "live-only",
  id: "vendor-negotiation-approval",
  title:
    "Vendor counteroffer stays in drafts and the Tuesday follow-up is scheduled",
  domain: "executive.vendor",
  tags: ["lifeops", "executive-assistant", "money", "messaging", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "LifeOps Vendor Negotiation Approval",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-vendor-counteroffer",
      room: "main",
      text: "The analytics vendor renewal is too expensive. Draft a counteroffer using our last invoice and usage, but keep it in drafts.",
      plannerExcludes: ["send_to_agent", "list_agents"],
      responseExcludes: ["already sent", "i've sent", "i have sent", "sent it"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must present a concrete counteroffer draft grounded in the renewal pricing pressure (what we pay, what we ask for) and state that it is staged as a draft pending owner approval. Claiming it was sent, or a vague 'I'll work on it', fails.",
      },
    },
    {
      kind: "message",
      name: "track-vendor-response",
      room: "main",
      text: "Also create a follow-up for next Tuesday if they don't reply, and mark it as low-noise unless the price changes.",
      plannerExcludes: ["calendar_action"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm a concrete follow-up was scheduled for next Tuesday with the low-noise condition attached, referencing the vendor thread. A bare acknowledgement without a scheduled item fails.",
      },
    },
  ],
  finalChecks: [
    // OUTCOME: the counteroffer draft went through a real messaging action
    // whose captured arguments carry the negotiation content.
    {
      type: "selectedActionArguments",
      name: "counteroffer-draft-args",
      actionName: ["MESSAGE", "GMAIL_ACTION", "INBOX"],
      includesAny: ["counteroffer", "renewal", "analytics"],
    },
    // NEGATIVE OUTCOME: draft-only — no delivered external send occurred.
    {
      type: "custom",
      name: "vendor-draft-gate-held",
      predicate: expectNoExternalSendDispatch(),
    },
    // OUTCOME: the Tuesday follow-up is a captured scheduled item whose
    // arguments carry the vendor follow-up.
    {
      type: "selectedActionArguments",
      name: "tuesday-followup-scheduled-with-args",
      actionName: ["SCHEDULED_TASKS", "OWNER_REMINDERS", "OWNER_TODOS", "LIFE"],
      includesAll: ["tuesday"],
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "vendor-negotiation-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the assistant drafted a grounded counteroffer that stayed in drafts (nothing dispatched externally) and scheduled a conditional low-noise follow-up for next Tuesday tied to the vendor's reply.",
    },
  ],
});
