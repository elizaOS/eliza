/**
 * Rolodex add-contact: user asks to add Alice Chen from Acme Inc.
 * The canonical CONTACT create operation must persist the exact person and
 * company note; an action selection or friendly reply alone is insufficient.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { expectCreatedContact } from "./_assertions.js";

export default scenario({
  lane: "live-only",
  id: "rolodex.add-contact",
  title: "Add a new contact to the Rolodex",
  domain: "relationships",
  evidenceScope: "domain-contract",
  tags: ["lifeops", "relationships", "happy-path", "smoke"],
  description:
    "User asks to add Alice Chen from Acme Inc. The canonical CONTACT create operation must persist the exact name and company note.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: add contact",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "add-alice",
      room: "main",
      text: "Add Alice Chen to my contacts with the note 'Acme Inc'.",
      expectedActions: ["CONTACT"],
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CONTACT",
      minCount: 1,
    },
    {
      type: "custom",
      name: "created-contact-survives-durable-readback",
      predicate: (ctx) =>
        expectCreatedContact({
          ctx,
          name: "Alice Chen",
          metadataIncludes: "Acme Inc",
        }),
    },
  ],
});
