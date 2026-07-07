/**
 * Co-parenting conflict-recovery scenario for LifeOps.
 * It covers a sick-kid disruption on the other parent's day while requiring
 * factual options instead of editorializing about responsibility.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "j1-schedule-conflict-recovery",
  title: "Sick-kid schedule conflict produces factual options and gated drafts",
  domain: "lifeops.coparenting",
  tags: ["lifeops", "coparenting", "calendar", "messaging", "mvp", "14789"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "J1 Conflict Recovery",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed-conflicting-work-block",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Client budget review conflicts with Mira sick pickup",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+4h}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "recover-conflict",
      room: "main",
      text: "Mira is sick on Sam's day and the school called me. Look at my conflict and draft factual options: one to Sam, one to move the client budget review if needed. No commentary about whose day it is, and do not send.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseExcludes: [
        "Sam should have",
        "his responsibility",
        "her responsibility",
        "already sent",
      ],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must ground in the client budget review conflict, offer factual options for Sam and the client, and keep drafts unsent. It fails if it blames either parent or editorializes about whose custody day it is.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Client budget review conflicts with Mira sick pickup",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "custom",
      name: "conflict-recovery-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "j1-conflict-recovery-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the assistant used the seeded conflict, produced factual co-parent/client options, avoided blame, and sent nothing externally before approval.",
    },
  ],
});
