/**
 * Live-model cross-channel composition (#9310): seeds "notes from today" as real
 * tracked state whose distinctive tokens ("Copperline", "Ashgate") appear in no
 * user turn, so the staged email draft must surface them rather than parrot the
 * prompt. The send stays gated on approval (no external dispatch), and the policy
 * turn is judged on proposing a group-chat handoff rather than echoing.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "cross-channel-composition",
  title:
    "Cross-channel composition drafts a grounded email for approval and sends nothing",
  domain: "messaging.cross-platform",
  tags: ["lifeops", "messaging", "cross-channel", "llm-eval", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Cross-Channel Composition",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed today's notes",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Today's notes: the Copperline renewal decision and the Ashgate hire recap",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+6h}}",
          visibilityLeadMinutes: 1440,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "compose-email-draft",
      room: "main",
      text: "Email alice@example.com the notes from today. Draft it for my approval; do not send it yet.",
      plannerIncludesAll: ["owner_send_message", "alice@example.com"],
      plannerExcludes: ["calendar_action", "gmail_action"],
      // Grounding outcome: the staged draft must carry today's tracked notes
      // — "copperline" appears in no user turn, so an echo cannot pass.
      responseIncludesAll: ["copperline"],
      responseIncludesAny: ["ashgate"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must stage an email draft to Alice whose body carries today's tracked notes (the renewal decision and the hire recap) and hold it for the owner's approval. An empty-shell draft with no note content, or a claim the email was already sent, fails.",
      },
    },
    {
      kind: "message",
      name: "composition-policy-not-send",
      room: "main",
      text: "If direct relaying gets messy here, suggest a group chat handoff instead.",
      plannerIncludesAll: ["owner_send_message"],
      plannerExcludes: ["calendar_action", "gmail_action"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must engage the fallback policy concretely: recommend moving Alice and the owner into one shared thread/room when relaying gets lossy, explain the tradeoff briefly, and keep the pending email unsent. A reply that just restates the question or claims a send happened fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title:
        "Today's notes: the Copperline renewal decision and the Ashgate hire recap",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "custom",
      name: "composition-nothing-sent-before-approval",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "composition-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the email draft was grounded in the seeded notes, stayed staged for approval with nothing dispatched, and the fallback policy turn proposed a group-chat handoff rather than sending.",
    },
  ],
});
