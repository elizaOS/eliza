/**
 * Rolodex update notes: seed a contact, then user asks to add a note
 * to Alice. CONTACT update must survive a read from RelationshipsService.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { expectContactPreference } from "./_assertions.js";

export default scenario({
  lane: "live-only",
  id: "rolodex.update-notes",
  title: "Update a contact's notes",
  domain: "relationships",
  evidenceScope: "domain-contract",
  tags: ["lifeops", "relationships", "happy-path"],
  description:
    "Alice Chen exists in the Rolodex. CONTACT update must persist the new note in the RelationshipsService contact record.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: update notes",
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
      name: "append-note",
      room: "main",
      text: "Add to Alice's notes: 'met at Sundance'",
      expectedActions: ["CONTACT"],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "rolodex-update-carries-contact-and-note",
      predicate: (ctx) =>
        expectContactPreference({
          ctx,
          name: "Alice Chen",
          key: "notes",
          includes: "met at Sundance",
        }),
    },
  ],
});
