/** Proves MESSAGE consolidates one canonical person's cross-platform threads. */
import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  acceptCanonicalIdentityMerge,
  assertCanonicalIdentityMerged,
  seedCanonicalIdentityFixture,
} from "../../../../test/helpers/lifeops-identity-merge-fixtures.ts";

const PERSON_NAME = "Scenario Priya Rao";
const PERSON_ALIAS = "Scenario P. Rao";

export default scenario({
  lane: "pr-deterministic",
  id: "cross-platform.inbox",
  title: "Consolidate one person's cross-platform conversation threads",
  domain: "messaging.cross-platform",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: ["cross-platform", "messaging", "identity-merge", "durable-readback"],
  description:
    "Invokes MESSAGE.read_with_contact and verifies one scenario-scoped canonical person spanning five seeded platform rooms and ten stored messages.",
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
          seedKey: "scenario-priya",
          personName: PERSON_NAME,
          priorNames: [PERSON_ALIAS],
        });
        if (!fixture.alreadySeeded) {
          await acceptCanonicalIdentityMerge(runtime, fixture);
        }
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "action",
      name: "request-deduped-inbox",
      room: "main",
      actionName: "MESSAGE",
      text: "Read the canonical person's cross-platform conversation threads.",
      options: {
        parameters: { action: "read_with_contact", contact: PERSON_NAME },
      },
      responseIncludes: ["Priya Rao", "5 thread(s)", "10 messages"],
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
      predicate: (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "MESSAGE" && entry.result?.success,
        );
        const data = action?.result?.data as
          | {
              operation?: string;
              personName?: string;
              totalMessages?: number;
              conversations?: Array<{ platform?: string }>;
            }
          | undefined;
        if (
          data?.operation !== "read_with_contact" ||
          data.personName !== PERSON_NAME
        ) {
          return `expected a successful canonical MESSAGE.read_with_contact result for ${PERSON_NAME}`;
        }
        if (data.totalMessages !== 10 || data.conversations?.length !== 5) {
          return `expected 5 threads and 10 messages, got ${data.conversations?.length ?? 0} and ${data.totalMessages ?? 0}`;
        }
        const platforms = new Set(
          data.conversations.map((conversation) => conversation.platform),
        );
        for (const platform of [
          "gmail",
          "signal",
          "telegram",
          "whatsapp",
          "discord",
        ]) {
          if (!platforms.has(platform)) {
            return `canonical conversation result omitted ${platform}`;
          }
        }
        return undefined;
      },
    },
  ],
});
