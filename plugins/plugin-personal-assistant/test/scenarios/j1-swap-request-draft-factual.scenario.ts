/**
 * Co-parenting swap-request draft scenario for LifeOps messaging coverage.
 * It proves a tense cross-household ask stays factual and approval-gated.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "j1-swap-request-draft-factual",
  title: "Swap request draft stays factual and waits for owner approval",
  domain: "lifeops.coparenting",
  tags: ["lifeops", "coparenting", "messaging", "approvals", "mvp", "14789"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "J1 Swap Request",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed-parent-teacher-conflict",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Mira teacher conference overlaps Friday exchange",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+2d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "draft-swap",
      room: "main",
      text: "Draft a message to Sam asking if we can swap this Friday exchange because of the teacher conference. Keep it purely factual, no commentary about the divorce, and do not send without me approving it.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseIncludesAll: ["Friday", "teacher conference"],
      responseExcludes: [
        "divorce",
        "unfair",
        "always",
        "never",
        "sent it",
        "already sent",
      ],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The reply must draft or summarize a neutral logistical swap request about the Friday teacher-conference conflict and explicitly hold it for approval. It fails if it comments on the divorce, blames Sam, uses always/never language, or claims the message was sent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Mira teacher conference overlaps Friday exchange",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "custom",
      name: "swap-request-approval-gate-held",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "j1-swap-draft-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the seeded conference conflict grounded the draft, the message stayed factual and co-parent-neutral, and no external send happened before approval.",
    },
  ],
});
