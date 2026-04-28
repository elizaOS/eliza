/**
 * Rolodex update notes: seed a contact, then user asks to add a note
 * to Alice. Expected action: UPDATE_CONTACT.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "rolodex.update-notes",
  title: "Update a contact's notes",
  domain: "relationships",
  tags: ["lifeops", "relationships", "happy-path"],
  description:
    "Alice Chen exists in the Rolodex. User asks to append a note. Agent must invoke UPDATE_CONTACT referencing 'Alice' or 'Sundance'.",

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
      expectedActions: ["UPDATE_CONTACT"],
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "UPDATE_CONTACT",
      minCount: 1,
    },
  ],
});
