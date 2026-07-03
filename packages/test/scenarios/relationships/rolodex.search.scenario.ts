/**
 * Rolodex search: seed three contacts (two at Acme, one elsewhere),
 * ask the agent to find everyone from Acme. Expected action: SEARCH_CONTACTS.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  callPayloadBlob,
  describeCalls,
  successfulCalls,
} from "../_helpers/effect-assertions.ts";

function expectAcmeSearchResult(ctx: ScenarioContext): string | undefined {
  if (successfulCalls(ctx, "SEARCH_CONTACTS").length === 0) {
    return `expected successful SEARCH_CONTACTS call; calls: ${describeCalls(ctx)}`;
  }
  const blob = callPayloadBlob(ctx, "SEARCH_CONTACTS");
  if (!/acme/.test(blob)) {
    return `expected SEARCH_CONTACTS payload/result to include Acme, saw ${blob.slice(0, 600)}`;
  }

  const reply = ctx.turns?.at(-1)?.responseText ?? "";
  if (!/alice/i.test(reply) || !/bob/i.test(reply)) {
    return `expected reply to list seeded Acme contacts Alice and Bob, saw ${JSON.stringify(reply)}`;
  }
  if (/carol/i.test(reply)) {
    return `expected non-Acme contact Carol to be excluded, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
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
      type: "custom",
      name: "rolodex-search-returns-acme-contacts",
      predicate: expectAcmeSearchResult,
    },
  ],
});
