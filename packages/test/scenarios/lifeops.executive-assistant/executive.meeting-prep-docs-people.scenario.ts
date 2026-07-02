import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "executive.meeting-prep-docs-people",
  title: "Meeting prep gathers people, docs, threads, and open decisions",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "meeting-prep", "documents"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Meeting prep",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prep-next-meeting",
      room: "main",
      text: "Prep me for my next meeting with Dana: pull related docs, recent threads, people context, decisions needed, and likely follow-ups.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "CALENDAR",
          "MESSAGE",
          "OWNER_DOCUMENTS",
          "RELATIONSHIP",
          "LIFE",
        ],
        description: "meeting prep context assembly",
        includesAny: ["Dana", "docs", "threads", "decisions", "follow-ups"],
      }),
      // Derived brief framing: a real prep reply is structured as a
      // brief/agenda — none of these tokens appear in the user turn, so a
      // parroted "I'll pull docs and threads for Dana" cannot pass.
      responseIncludesAny: ["brief", "agenda", "talking points", "summary"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must be a prep brief with people context, documents/threads, open decisions, and follow-ups. It should not merely say the meeting exists.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "CALENDAR",
        "MESSAGE",
        "OWNER_DOCUMENTS",
        "RELATIONSHIP",
        "LIFE",
      ],
    },
    {
      type: "custom",
      name: "meeting-prep-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "CALENDAR",
          "MESSAGE",
          "OWNER_DOCUMENTS",
          "RELATIONSHIP",
          "LIFE",
        ],
        description: "meeting prep context assembly",
        includesAny: ["Dana", "docs", "threads", "decisions", "follow-ups"],
      }),
    },
    judgeRubric({
      name: "executive-meeting-prep-rubric",
      threshold: 0.7,
      description:
        "Agent assembles a practical meeting-prep brief spanning calendar, docs, threads, and people context.",
    }),
  ],
});
