/**
 * Dedup the same person across Email + Telegram — agent must treat one
 * person reachable on two channels as ONE entity, not two.
 *
 * Failure modes guarded:
 *   - listing the same person twice (once per channel)
 *   - failing to surface either channel
 *
 * Cited: 03-coverage-gap-matrix.md — 2-channel dedup.
 */

import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import {
  acceptCanonicalIdentityMerge,
  assertCanonicalIdentityMerged,
  seedCanonicalIdentityFixture,
} from "../../../plugins/app-lifeops/test/helpers/lifeops-identity-merge-fixtures.ts";
import {
  expectScenarioToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const PERSON_NAME = "Priya Rao";

export default scenario({
  id: "cross-channel.same-person-email-and-telegram",
  title: "Same person on Email + Telegram dedupes to one canonical identity",
  domain: "lifeops.cross-channel",
  tags: ["lifeops", "cross-channel", "dedup", "identity-merge"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Same Person Email+Telegram",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-canonical-identity",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        const fixture = await seedCanonicalIdentityFixture({
          runtime,
          seedKey: "lifeops-cc-email-telegram",
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
      name: "ask-for-priya-across-email-telegram",
      room: "main",
      text: `What has Priya Rao been saying to me lately? She emails me and Telegrams me — same person.`,
      responseIncludesAny: ["Priya", "Gmail", "Telegram"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must treat Priya as one person across Gmail and Telegram, mentioning both channels at most once each.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "canonical-merge-preserved",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        return assertCanonicalIdentityMerged({
          runtime,
          personName: PERSON_NAME,
        });
      },
    },
    {
      type: "custom",
      name: "cross-channel-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "READ_MESSAGES", "INBOX_TRIAGE"],
        description: "lookup across Gmail + Telegram for canonical Priya",
        includesAny: ["priya", "gmail", "telegram"],
      }),
    },
    judgeRubric({
      name: "cross-channel-email-telegram-rubric",
      threshold: 0.75,
      description:
        "Agent presented Priya as one canonical person with both Gmail and Telegram context, not two distinct contacts.",
    }),
  ],
});
