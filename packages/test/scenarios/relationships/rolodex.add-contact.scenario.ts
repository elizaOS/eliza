/**
 * Rolodex add-contact: user asks to add Alice Chen from Acme Inc.
 * Expected action: ADD_CONTACT (from the canonical action catalog,
 * core/advanced-capabilities). Captured params must reference "Alice".
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "rolodex.add-contact",
  title: "Add a new contact to the Rolodex",
  domain: "relationships",
  tags: ["lifeops", "relationships", "happy-path", "smoke"],
  description:
    "User asks to add Alice Chen from Acme Inc. Agent must invoke ADD_CONTACT with a name containing 'Alice'.",

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
      text: "Add Alice Chen to my contacts, she's at Acme Inc.",
      expectedActions: ["ADD_CONTACT"],
      expectedActionParams: {
        ADD_CONTACT: { $regex: "Alice" },
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "ADD_CONTACT",
      minCount: 1,
    },
  ],
});
