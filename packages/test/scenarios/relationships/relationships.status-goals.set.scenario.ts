import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  callPayloadBlob,
  describeCalls,
  successfulCalls,
} from "../_helpers/effect-assertions.ts";

function expectRelationshipGoalPayload(
  ctx: ScenarioContext,
): string | undefined {
  if (successfulCalls(ctx, "RELATIONSHIP").length === 0) {
    return `expected successful RELATIONSHIP call; calls: ${describeCalls(ctx)}`;
  }
  const blob = callPayloadBlob(ctx, "RELATIONSHIP");
  if (!/alice/.test(blob)) {
    return `expected RELATIONSHIP payload to reference Alice, saw ${blob.slice(0, 600)}`;
  }
  if (!/(quarterly|stay in touch)/.test(blob)) {
    return `expected RELATIONSHIP payload to carry the quarterly stay-in-touch note, saw ${blob.slice(0, 600)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "relationships.status-goals.set",
  title: "Relationship goal request routes into generic relationship handling",
  domain: "relationships",
  tags: ["lifeops", "relationships", "routing"],
  description:
    "A relationship-goal request currently routes into the generic RELATIONSHIP flow instead of a dedicated goal-setting action.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: set goal",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "Alice Chen",
      handles: [{ platform: "gmail", identifier: "alice@acme.example.com" }],
      notes: "Acme Inc",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "set-relationship-goal",
      room: "main",
      text: "Add to Alice's notes: 'stay in touch quarterly'.",
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "relationship-goal-carries-contact-and-note",
      predicate: expectRelationshipGoalPayload,
    },
  ],
});
