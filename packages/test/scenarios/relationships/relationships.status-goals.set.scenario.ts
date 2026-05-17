import { scenario } from "@elizaos/scenario-schema";

export default scenario({
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
      type: "actionCalled",
      actionName: "RELATIONSHIP",
      minCount: 1,
    },
  ],
});
