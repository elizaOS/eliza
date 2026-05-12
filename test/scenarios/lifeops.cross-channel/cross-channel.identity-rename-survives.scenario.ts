/**
 * Identity rename survives — when a contact changes display name (e.g.
 * marriage), the canonical identity persists. The agent must NOT split
 * pre-rename and post-rename messages into two people.
 *
 * Failure modes guarded:
 *   - treating "Priya Rao" and "Priya Smith" as different people
 *   - losing all pre-rename history on rename
 *
 * Cited: 03-coverage-gap-matrix.md — rename survival.
 */

import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import {
  acceptCanonicalIdentityMerge,
  assertCanonicalIdentityMerged,
  seedCanonicalIdentityFixture,
} from "../../../plugins/app-lifeops/test/helpers/lifeops-identity-merge-fixtures.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const PERSON_NAME = "Priya Rao";

export default scenario({
  id: "cross-channel.identity-rename-survives",
  title: "Display-name rename does not split canonical identity",
  domain: "lifeops.cross-channel",
  tags: ["lifeops", "cross-channel", "identity", "rename", "merge"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Identity Rename",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-renamed-canonical",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        const fixture = await seedCanonicalIdentityFixture({
          runtime,
          seedKey: "lifeops-cc-rename",
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
      name: "ask-history-after-rename",
      room: "main",
      text: `Priya Rao just changed her last name to Smith. Show me everything I've ever talked to her about across email and chat — same person, just different name now.`,
      responseIncludesAny: ["Priya"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Reply must treat Priya as one continuous person across the rename, surfacing pre- and post-rename history together.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "canonical-identity-survives-rename",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        return assertCanonicalIdentityMerged({
          runtime,
          personName: PERSON_NAME,
        });
      },
    },
    judgeRubric({
      name: "cross-channel-rename-survives-rubric",
      threshold: 0.75,
      description:
        "Agent surfaces continuous history for Priya before and after the surname change, not as two separate people.",
    }),
  ],
});
