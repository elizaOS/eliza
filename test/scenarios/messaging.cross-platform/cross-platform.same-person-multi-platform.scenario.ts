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
  id: "cross-platform.same-person-multi-platform",
  title: "Recognize one person across Gmail, Signal, Telegram, and WhatsApp",
  domain: "messaging.cross-platform",
  tags: [
    "cross-platform",
    "messaging",
    "identity-merge",
    "parameter-extraction",
  ],
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
      title: "Cross-Platform Same Person",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-canonical-identity-merge",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) {
          return "scenario runtime unavailable";
        }
        const fixture = await seedCanonicalIdentityFixture({
          runtime,
          seedKey: "scenario-same-person",
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
      name: "ask about priyas cross-platform messages",
      room: "main",
      text: "Show me everywhere Priya Rao has messaged me recently. She is the same person across Gmail, Signal, Telegram, and WhatsApp.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "READ_MESSAGES",
          "MESSAGE",
          "MESSAGE",
        ],
        description:
          "cross-platform conversation lookup for one canonical person",
        includesAny: ["priya", "gmail", "signal", "telegram", "whatsapp"],
      }),
      responseIncludesAny: ["Priya", "Gmail", "Signal", "Telegram", "WhatsApp"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The assistant must treat Priya Rao as one person, not multiple disconnected contacts, and summarize cross-platform message context across Gmail, Signal, Telegram, and WhatsApp.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "cross-platform-same-person-canonical-merge",
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
      name: "cross-platform-same-person-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "READ_MESSAGES",
          "MESSAGE",
          "MESSAGE",
        ],
        description:
          "cross-platform conversation lookup for one canonical person",
        includesAny: ["priya", "gmail", "signal", "telegram", "whatsapp"],
      }),
    },
    judgeRubric({
      name: "cross-platform-same-person-rubric",
      threshold: 0.75,
      description:
        "End-to-end: Priya Rao is handled as one canonical person whose conversation context spans Gmail, Signal, Telegram, and WhatsApp.",
    }),
  ],
});
