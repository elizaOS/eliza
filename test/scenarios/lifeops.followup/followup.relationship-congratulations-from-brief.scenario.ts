import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.relationship-congratulations-from-brief",
  title: "Trigger a congratulations follow-up from a news item in the morning brief",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "relationships", "brief"],
  description:
    "Morning brief surfaced a news item that someone in the rolodex got a new role. The agent must propose a concrete congratulations draft (not generic), sent on the right channel for that contact (e.g. their primary handle, not a random one).",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Congrats from brief",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "rolodex-entity",
        name: "Alex Rivera",
        primaryChannel: "telegram",
        telegramHandle: "@arivera",
        recentNews: "promoted to VP Engineering at Acme",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "congrats-draft",
      room: "main",
      text: "Alex Rivera was promoted to VP Engineering at Acme. Draft a quick congrats and queue it on her primary channel.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "RELATIONSHIP"],
        description: "personalized congrats draft via primary channel",
        includesAny: ["Alex", "VP", "Engineering", "Acme", "congrats"],
      }),
      responseIncludesAny: ["Alex", "VP", "Engineering", "Acme", "congrats"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must produce a draft that names Alex, her new VP Engineering role, and Acme — and indicate routing to her telegram (her primary channel). Generic 'congrats!' or wrong-channel routing fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "RELATIONSHIP"],
    },
    {
      type: "custom",
      name: "followup-congrats-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "RELATIONSHIP"],
        description: "personalized congrats from brief",
      }),
    },
    judgeRubric({
      name: "followup-congrats-rubric",
      threshold: 0.7,
      description:
        "Draft is personalized (names, role, company) and routed to the contact's primary channel.",
    }),
  ],
});
