/**
 * Same person across 4 channels — Gmail + Signal + Telegram + Discord. The
 * agent must surface all four channels in one summary without listing the
 * same person 4x.
 *
 * Failure modes guarded:
 *   - skipping one of the four channels
 *   - duplicating the person row per channel
 *
 * Cited: 03-coverage-gap-matrix.md — 4-channel dedup at scale.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
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
const EXPECTED_CHANNELS = ["gmail", "signal", "telegram", "discord"];

function checkAllFourChannelsMentioned(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty reply on 4-channel query";
  const missing = EXPECTED_CHANNELS.filter((c) => !reply.includes(c));
  if (missing.length > 0) {
    return `Reply missing channels: ${missing.join(", ")}. Reply: ${reply.slice(0, 400)}`;
  }
  // Count Priya mentions — if >6 (one per channel + 2 prose), likely
  // duplicate listings.
  const priyaCount = (reply.match(/priya/g) ?? []).length;
  if (priyaCount > 8) {
    return `Reply mentions Priya ${priyaCount} times — likely duplicated per channel. Should treat as one canonical person.`;
  }
  return undefined;
}

export default scenario({
  id: "cross-channel.same-person-4-platforms",
  title: "Same person across Gmail + Signal + Telegram + Discord dedupes",
  domain: "lifeops.cross-channel",
  tags: ["lifeops", "cross-channel", "dedup", "identity-merge", "scale"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Same Person Across 4 Platforms",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-canonical-identity-4ch",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        const fixture = await seedCanonicalIdentityFixture({
          runtime,
          seedKey: "lifeops-cc-4ch",
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
      name: "ask-priya-across-4",
      room: "main",
      text: `Show me everywhere Priya Rao has reached out — Gmail, Signal, Telegram, Discord. She's the same person on all four.`,
      timeoutMs: 180_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "all-four-channels-mentioned",
      predicate: checkAllFourChannelsMentioned,
    },
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
        description: "4-channel lookup for canonical Priya",
        includesAny: ["priya", "gmail", "signal", "telegram", "discord"],
      }),
    },
    judgeRubric({
      name: "cross-channel-4-platforms-rubric",
      threshold: 0.75,
      description:
        "Agent surfaced Priya context across all 4 channels (Gmail, Signal, Telegram, Discord) as one canonical person.",
    }),
  ],
});
