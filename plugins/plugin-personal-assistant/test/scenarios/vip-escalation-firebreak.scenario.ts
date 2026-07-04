// Defines the vip escalation firebreak LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

/**
 * Seeds REAL state through the LifeOps definition API — the Whitmore & Kent Bellwether-acquisition redline matter and a noise newsletter that must never interrupt — and asserts the firebreak both ways: the escalation summary must be grounded in the seeded legal matter (absent from every user turn) while the seeded noise item stays out of it.
 */
export default scenario({
  lane: "live-only",
  id: "vip-escalation-firebreak",
  title:
    "VIP firebreak holds the watch and grounds the escalation in the seeded legal matter",
  domain: "executive.escalation",
  tags: [
    "lifeops",
    "executive-assistant",
    "prioritize",
    "messaging",
    "outcome",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps VIP Escalation Firebreak",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed legal redline matter",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Legal matter — Whitmore & Kent, Bellwether acquisition redline",
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
      kind: "api",
      name: "seed noise newsletter digest",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Newsletter digest — Cormorant Weekly (noise, never interrupt)",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+3d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "classify-vip-vs-noise",
      room: "main",
      text: "I'm in deep work for two hours. Watch messages and only interrupt me if Clara, the board chair, or legal needs a same-day decision.",
      plannerIncludesAll: ["PRIORITIZE", "SCHEDULED_TASKS"],
      plannerExcludes: ["owner_send_message", "calendar_action"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The reply must install the two-hour watch with exactly the three interrupt classes the owner named (Clara, board chair, legal same-day decisions) and hold everything else. Widening the interrupt set, or claiming a message was sent, fails.",
      },
    },
    {
      kind: "message",
      name: "escalate-confirmed-vip",
      room: "main",
      text: "Legal just sent a redline deadline for tonight; draft the shortest interruption summary and ask me for the decision.",
      plannerExcludes: ["send_to_agent", "list_agents"],
      // Grounding outcome: the escalation must surface the seeded legal
      // matter — neither "whitmore" nor "bellwether" appears in any user
      // turn, so an echo cannot pass.
      responseIncludesAny: ["whitmore", "bellwether"],
      // Firebreak: the seeded noise newsletter must stay out of the
      // interruption summary.
      responseExcludes: ["cormorant"],
      responseJudge: {
        minimumScore: 0.6,
        rubric:
          "The interruption summary must be the shortest possible grounding of the seeded matter (the Whitmore & Kent Bellwether redline, due tonight) ending in a single decision request to the owner. Padding it with noise items or unrelated material fails.",
      },
    },
  ],
  finalChecks: [
    // The seeded state the replies were graded against persisted.
    {
      type: "definitionCountDelta",
      title: "Legal matter — Whitmore & Kent, Bellwether acquisition redline",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Newsletter digest — Cormorant Weekly (noise, never interrupt)",
      delta: 1,
      cadenceKind: "once",
    },
    // NEGATIVE OUTCOME: drafts only — no delivered external send occurred.
    {
      type: "custom",
      name: "vip-firebreak-gate-held",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "vip-escalation-end-to-end",
      minimumScore: 0.6,
      rubric:
        "End-to-end: the watch held the three named interrupt classes, the escalation was grounded in the seeded Whitmore & Kent Bellwether redline, the noise digest never surfaced, and no outbound message was delivered.",
    },
  ],
});
