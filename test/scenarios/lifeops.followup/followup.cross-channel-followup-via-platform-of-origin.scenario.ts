import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.cross-channel-followup-via-platform-of-origin",
  title: "Follow-up goes back through the platform the conversation started on",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "cross-channel", "routing"],
  description:
    "The original thread is on Telegram. The follow-up dispatch must go to Telegram (not Discord, not Gmail) — bug class: agent picks the user's 'preferred' channel and accidentally bridges identity to a counterparty who only knows them on Telegram.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-channel routing",
    },
    {
      id: "telegram",
      source: "telegram",
      channelType: "DM",
      title: "Telegram thread of origin",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "telegram",
      content: {
        kind: "open-thread",
        counterparty: "Mira",
        platformOfOrigin: "telegram",
        topic: "merch design preview",
        lastInbound: new Date(Date.now() - 30 * 60 * 60_000).toISOString(),
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "send-followup",
      room: "main",
      text: "Bump Mira about the merch design preview. Use the same channel we've been on.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "RELATIONSHIP"],
        description: "platform-of-origin routing",
        includesAny: ["Mira", "telegram", "merch", "design"],
      }),
      responseIncludesAny: ["Mira", "telegram", "merch"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must route the follow-up through Telegram (platform of origin). Routing via Discord, Gmail, SMS, or 'the user's primary' instead fails — it would bridge identity to a stranger.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "RELATIONSHIP"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: ["telegram"],
    },
    {
      type: "custom",
      name: "followup-platform-origin-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "RELATIONSHIP"],
        description: "platform-of-origin follow-up",
      }),
    },
    {
      type: "custom",
      name: "followup-platform-origin-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["telegram"],
        description: "follow-up routed to Telegram",
      }),
    },
    judgeRubric({
      name: "followup-platform-origin-rubric",
      threshold: 0.7,
      description:
        "Follow-up routed via Telegram (the thread's platform of origin), not bridged to a different channel.",
    }),
  ],
});
