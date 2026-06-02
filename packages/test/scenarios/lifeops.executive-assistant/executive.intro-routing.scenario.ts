import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.intro-routing",
  title: "Intro routing decides accept, delegate, decline, or schedule",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "inbox", "relationships"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Intro routing",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "intro-routing",
      room: "main",
      text: "Triage inbound intro requests: decide accept, delegate, decline, or schedule; use relationship context and draft replies for approval.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "INBOX",
          "MESSAGE",
          "RELATIONSHIP",
          "CALENDAR",
          "RESOLVE_REQUEST",
        ],
        description: "intro routing triage",
        includesAny: ["intro", "delegate", "decline", "schedule", "approval"],
      }),
      responseIncludesAny: [
        /intro|relationship/i,
        /delegate|decline|schedule|approval/i,
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should classify intro requests into accept/delegate/decline/schedule and draft approval-ready replies.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "INBOX",
        "MESSAGE",
        "RELATIONSHIP",
        "CALENDAR",
        "RESOLVE_REQUEST",
      ],
    },
    {
      type: "custom",
      name: "intro-routing-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "INBOX",
          "MESSAGE",
          "RELATIONSHIP",
          "CALENDAR",
          "RESOLVE_REQUEST",
        ],
        description: "intro routing triage",
        includesAny: ["intro", "delegate", "decline", "schedule", "approval"],
      }),
    },
    judgeRubric({
      name: "executive-intro-routing-rubric",
      threshold: 0.7,
      description:
        "Agent routes intro requests with relationship context and approval-ready replies.",
    }),
  ],
});
