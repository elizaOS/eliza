import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.set-cadence-quarterly",
  title: "Set a quarterly check-in cadence on a specific relationship",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "relationships", "cadence"],
  description:
    "User wants quarterly check-ins with their old mentor. The agent must persist the cadence on the contact (not a generic 30-day default) and confirm the cadence back specifically.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Quarterly cadence",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Dr. Lena Park",
        relationship: "mentor",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set-quarterly-cadence",
      room: "main",
      text: "I want quarterly check-ins with Dr. Lena Park — set that cadence so you remind me every 90 days.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "per-contact cadence setting",
        includesAny: ["quarterly", "90 days", "Lena", "cadence"],
      }),
      responseIncludesAny: ["quarterly", "90", "Lena", "every 3 months"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm a 90-day / quarterly cadence specifically on Dr. Lena Park. A generic 'I'll follow up' or applying a 30-day default fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP", "LIFE"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["RELATIONSHIP", "LIFE"],
      includesAny: ["quarterly", "90", "Lena", "cadence"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "followup-quarterly-cadence-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "LIFE"],
        description: "per-contact cadence",
        includesAny: ["quarterly", "90", "Lena"],
      }),
    },
    {
      type: "custom",
      name: "followup-quarterly-cadence-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "cadence saved against the contact",
        contentIncludesAny: ["quarterly", "90", "Lena", "cadence"],
      }),
    },
    judgeRubric({
      name: "followup-quarterly-cadence-rubric",
      threshold: 0.7,
      description:
        "Quarterly (90-day) cadence saved specifically against Dr. Lena Park.",
    }),
  ],
});
