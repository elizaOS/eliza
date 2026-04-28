import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "discord.local.read-recent",
  title: "Read recent Discord DMs via local plugin",
  domain: "messaging.discord-local",
  tags: ["messaging", "discord", "happy-path", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Discord Local Read",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "read discord dms",
      room: "main",
      text: "What's in my Discord DMs?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["INBOX"],
        description: "discord DM read",
        includesAny: ["discord", "dm", "message"],
      }),
      responseIncludesAny: ["discord", "dm", "message"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must summarize or acknowledge recent Discord DM content. A generic 'I checked Discord' response without surfacing DM context fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "INBOX",
    },
    {
      type: "selectedActionArguments",
      actionName: "INBOX",
      includesAny: ["discord", "dm", "message"],
    },
    {
      type: "custom",
      name: "discord-local-read-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["INBOX"],
        description: "discord DM read",
        includesAny: ["discord", "dm", "message"],
      }),
    },
    judgeRubric({
      name: "discord-local-read-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant read recent Discord DMs and surfaced useful DM context instead of returning a generic inbox acknowledgement.",
    }),
  ],
});
