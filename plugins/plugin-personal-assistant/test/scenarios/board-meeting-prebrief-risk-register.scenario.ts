/**
 * Live-model board-meeting prebrief + risk-register flow. Seeds real prebrief
 * state — an open metric gap ("Westerly churn
 * metric") and a risk-register entry ("Quillon vendor dependency") that appear
 * in no user turn — so the prebrief is grounded in seeded state rather than
 * parroted (#9310). The
 * follow-up turn must convert the seeded metric gap into a captured scheduled
 * action whose arguments carry it (selectedActionArguments), not just reply
 * wording.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "board-meeting-prebrief-risk-register",
  title:
    "Board prebrief surfaces seeded risk-register items and schedules the metric-gap follow-up",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "documents", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Board Meeting Prebrief",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed open metric gap",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Close the Westerly churn metric gap before the board packet",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+1d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed risk register entry",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title:
          "Risk register: update the Quillon vendor dependency entry for the board",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+1d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "build-board-prebrief",
      room: "main",
      text: "Prep me for tomorrow's board meeting. Pull the agenda, last board notes, open decisions, and the risk register we're tracking. Only show what changed.",
      plannerExcludes: ["OWNER_HEALTH"],
      // Grounding outcome: the prebrief must surface the seeded metric gap —
      // it appears in no user turn, so an echo cannot pass.
      responseIncludesAll: ["westerly"],
      responseIncludesAny: ["quillon"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The prebrief must be grounded in the tracked state: the open churn-metric gap and the vendor-dependency risk-register entry, framed as what changed before tomorrow's meeting. A generic board-prep outline that never touches the tracked items fails.",
      },
    },
    {
      kind: "message",
      name: "turn-gaps-into-followups",
      room: "main",
      text: "For the missing metrics, create follow-ups with owners and mark anything investor-sensitive for my review.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseIncludesAny: ["westerly", "churn"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm a concrete owner-assigned follow-up was created for the seeded churn-metric gap specifically, with investor-sensitive material flagged for the owner's review — not a bare acknowledgement and not a follow-up for a different item.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Close the Westerly churn metric gap before the board packet",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title:
        "Risk register: update the Quillon vendor dependency entry for the board",
      delta: 1,
      cadenceKind: "once",
    },
    // OUTCOME: the metric gap became a captured scheduled action whose
    // arguments carry the seeded item — not just reply wording.
    {
      type: "selectedActionArguments",
      name: "metric-gap-followup-with-args",
      actionName: [
        "SCHEDULED_TASKS",
        "OWNER_REMINDERS",
        "OWNER_TODOS",
        "LIFE",
        "PRIORITIZE",
      ],
      includesAny: ["westerly", "churn"],
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "board-prebrief-end-to-end",
      minimumScore: 0.7,
      rubric:
        "End-to-end: the prebrief surfaced the seeded churn-metric gap and vendor-dependency risk entry as what changed, and the metric gap was converted into a real owner-assigned follow-up rather than a promise.",
    },
  ],
});
