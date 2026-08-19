/** Scenario fixture for followup dismiss with reason; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "followup.dismiss-with-reason",
  title:
    "Dismissing a follow-up captures the user-supplied reason for future filtering",
  domain: "lifeops.followup",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "followup", "dismiss", "memory"],
  description:
    "User dismisses a recurring follow-up about a former colleague with a reason ('we don't work together anymore'). The agent must persist the reason on the contact so similar follow-ups don't get auto-resurfaced.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Dismiss with reason",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Pat Nguyen",
        followupThresholdDays: 30,
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "dismiss-with-reason",
      room: "main",
      text: "Stop following up on Pat Nguyen — we don't work together anymore and I don't want auto-bumps.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "dismiss with persisted reason",
        includesAny: ["Pat", "stop", "dismiss", "no longer"],
      }),
      responseIncludesAny: ["Pat", "stop", "no longer", "won't"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm Pat is removed from follow-up cadence AND that the 'we don't work together' reason is captured. Just 'okay' without persisting the reason fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP", "LIFE"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "followup-dismiss-reason-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "dismiss with reason",
        includesAny: ["Pat", "dismiss", "stop"],
      }),
    },
    {
      type: "custom",
      name: "followup-dismiss-reason-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "reason saved on the contact",
        contentIncludesAny: ["Pat", "no longer", "stop", "don't work"],
      }),
    },
    judgeRubric({
      name: "followup-dismiss-reason-rubric",
      threshold: 0.7,
      description:
        "Dismissal recorded the user-supplied reason for future filtering.",
    }),
  ],
});
