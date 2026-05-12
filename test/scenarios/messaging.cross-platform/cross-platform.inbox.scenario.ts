import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import {
  acceptCanonicalIdentityMerge,
  assertCanonicalIdentityMerged,
  seedCanonicalIdentityFixture,
} from "../../../plugins/app-lifeops/test/helpers/lifeops-identity-merge-fixtures.ts";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const PERSON_NAME = "Priya Rao";

export default scenario({
  id: "cross-platform.inbox",
  title: "Inbox dedupes one person across messaging platforms",
  domain: "messaging.cross-platform",
  tags: ["cross-platform", "messaging", "inbox", "identity-merge"],
  status: "pending",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-Platform Inbox",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-inbox-canonical-person",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) {
          return "scenario runtime unavailable";
        }
        const fixture = await seedCanonicalIdentityFixture({
          runtime,
          seedKey: "scenario-inbox",
          personName: PERSON_NAME,
        });
        await acceptCanonicalIdentityMerge(runtime, fixture);
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-deduped-inbox",
      room: "main",
      text: "Show me what unread messages need my attention from Priya Rao across Gmail, Signal, Telegram, and WhatsApp, without treating her like four different contacts.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "MESSAGE",
          "MESSAGE",
          "MESSAGE",
          "READ_MESSAGES",
        ],
        description: "deduped inbox lookup for one canonical person",
        includesAny: [
          "priya",
          "unread",
          "gmail",
          "signal",
          "telegram",
          "whatsapp",
        ],
      }),
      responseIncludesAny: [
        "Priya",
        "unread",
        "Gmail",
        "Signal",
        "Telegram",
        "WhatsApp",
      ],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must present Priya Rao as one person in the inbox view, while still surfacing her unread context across Gmail, Signal, Telegram, and WhatsApp.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "cross-platform-inbox-canonical-merge",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) {
          return "scenario runtime unavailable";
        }
        return assertCanonicalIdentityMerged({
          runtime,
          personName: PERSON_NAME,
        });
      },
    },
    {
      type: "custom",
      name: "cross-platform-inbox-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "MESSAGE",
          "MESSAGE",
          "MESSAGE",
          "READ_MESSAGES",
        ],
        description: "deduped inbox lookup for one canonical person",
        includesAny: [
          "priya",
          "unread",
          "gmail",
          "signal",
          "telegram",
          "whatsapp",
        ],
      }),
    },
    judgeRubric({
      name: "cross-platform-inbox-rubric",
      threshold: 0.75,
      description:
        "End-to-end: the inbox response dedupes Priya Rao into one canonical person while still surfacing unread context across Gmail, Signal, Telegram, and WhatsApp.",
    }),
  ],
});
