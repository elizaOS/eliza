/**
 * Rolodex search: seed three contacts, ask for one exact name, and require the
 * canonical CONTACT search result to include only that matching contact.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { expectSearchResultNames } from "./_assertions.js";

export default scenario({
  lane: "live-only",
  id: "rolodex.search",
  title: "Search the Rolodex by exact contact name",
  domain: "relationships",
  evidenceScope: "domain-contract",
  tags: ["lifeops", "relationships", "happy-path"],
  description:
    "Three contacts are seeded. CONTACT search must return Alice Chen for an exact-name query and exclude the two non-matching contacts.",

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
      name: "find-alice",
      room: "main",
      text: "Find Alice Chen in my contacts.",
      expectedActions: ["CONTACT"],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "rolodex-search-returns-exact-contact",
      predicate: (ctx) =>
        expectSearchResultNames({
          ctx,
          includes: ["Alice Chen"],
          excludes: ["Bob Rivera", "Carol Patel"],
        }),
    },
  ],
});
