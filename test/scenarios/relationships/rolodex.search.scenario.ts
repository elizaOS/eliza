/**
 * Rolodex search: seed three contacts (two at Acme, one elsewhere),
 * ask the agent to find everyone from Acme. Expected action: SEARCH_CONTACTS.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "rolodex.search",
  title: "Search Rolodex by company",
  domain: "relationships",
  tags: ["lifeops", "relationships", "happy-path"],
  description:
    "Three contacts are seeded with varying companies. Agent must invoke SEARCH_CONTACTS when asked to find everyone from Acme.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: search contacts",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "Alice Chen",
      handles: [{ platform: "gmail", identifier: "alice@acme.example.com" }],
      notes: "Acme Inc - engineering lead",
    },
    {
      type: "contact",
      name: "Bob Rivera",
      handles: [{ platform: "gmail", identifier: "bob@acme.example.com" }],
      notes: "Acme Inc - product manager",
    },
    {
      type: "contact",
      name: "Carol Patel",
      handles: [{ platform: "gmail", identifier: "carol@contoso.example.com" }],
      notes: "Contoso - designer",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "find-acme",
      room: "main",
      text: "Find everyone from Acme.",
      expectedActions: ["SEARCH_CONTACTS"],
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "SEARCH_CONTACTS",
      minCount: 1,
    },
  ],
});
