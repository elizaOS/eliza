/** Proves an alias resolves to one canonical cross-platform person. */
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
  id: "cross-platform.same-person-multi-platform",
  title: "Recognize one person across Gmail, Signal, Telegram, and WhatsApp",
  domain: "messaging.cross-platform",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: [
    "cross-platform",
    "messaging",
    "identity-merge",
    "parameter-extraction",
  ],
  description:
    "Queries MESSAGE.read_with_contact using a scenario-scoped alias and verifies it resolves to one canonical identity across every linked platform.",
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
      name: "ask about priyas cross-platform messages",
      room: "main",
      actionName: "MESSAGE",
      text: "Resolve this alias and read its cross-platform conversations.",
      options: {
        parameters: { action: "read_with_contact", contact: PERSON_ALIAS },
      },
      responseIncludes: ["Priya Rao", "5 thread(s)", "10 messages"],
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
      predicate: (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "MESSAGE" && entry.result?.success,
        );
        const data = action?.result?.data as
          | {
              operation?: string;
              personName?: string;
              platforms?: string[];
              totalMessages?: number;
            }
          | undefined;
        if (
          data?.operation !== "read_with_contact" ||
          data.personName !== PERSON_NAME
        ) {
          return `expected alias ${PERSON_ALIAS} to resolve to ${PERSON_NAME}`;
        }
        if (data.totalMessages !== 10 || data.platforms?.length !== 5) {
          return `expected one canonical five-platform result with ten messages, got ${JSON.stringify(data)}`;
        }
        return undefined;
      },
    },
  ],
});
