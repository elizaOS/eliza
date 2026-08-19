/**
 * Proves CONTACT imports an adapter-supplied Discord roster into the durable
 * Rolodex with stable platform identifiers and an exact requested count.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { expectImportedContacts } from "./_assertions.js";

const DISCORD_ROSTER = Array.from({ length: 20 }, (_, index) => ({
  platform: "discord",
  identifier: `scenario-discord-user-${String(index + 1).padStart(2, "0")}`,
  displayName: `Scenario Discord Partner ${String(index + 1).padStart(2, "0")}`,
}));

export default scenario({
  lane: "pr-deterministic",
  id: "relationships.import-from-platform",
  title: "Import a typed Discord roster into the Rolodex",
  domain: "relationships",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: ["lifeops", "relationships", "discord", "durable-readback"],
  description:
    "Calls CONTACT.import with a typed upstream roster and verifies all 20 Discord identities through RelationshipsService. This contract does not claim connector roster discovery.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    services: ["relationships"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: import from platform",
    },
  ],

  turns: [
    {
      kind: "action",
      name: "import-discord-contacts",
      room: "main",
      actionName: "CONTACT",
      text: "Import the supplied Discord contact roster.",
      options: {
        parameters: {
          action: "import",
          platform: "discord",
          contacts: DISCORD_ROSTER,
        },
      },
      responseIncludesAll: ["Imported 20 discord contacts", "skipped 0"],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "discord-import-persists-exact-contact-count",
      predicate: (ctx) =>
        expectImportedContacts({
          ctx,
          actionName: "CONTACT",
          platform: "discord",
          expectedCount: 20,
        }),
    },
  ],
});
