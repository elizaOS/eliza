/**
 * Rolodex update notes: seed a contact, then user asks to add a note
 * to Alice. Expected action: UPDATE_CONTACT.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  callPayloadBlob,
  describeCalls,
  successfulCalls,
} from "../_helpers/effect-assertions.ts";

function expectAliceSundanceUpdate(ctx: ScenarioContext): string | undefined {
  if (successfulCalls(ctx, "UPDATE_CONTACT").length === 0) {
    return `expected successful UPDATE_CONTACT call; calls: ${describeCalls(ctx)}`;
  }
  const blob = callPayloadBlob(ctx, "UPDATE_CONTACT");
  if (!/alice/.test(blob)) {
    return `expected UPDATE_CONTACT payload to reference Alice, saw ${blob.slice(0, 600)}`;
  }
  if (!/sundance/.test(blob)) {
    return `expected UPDATE_CONTACT payload to carry the Sundance note, saw ${blob.slice(0, 600)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
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
      type: "custom",
      name: "rolodex-update-carries-contact-and-note",
      predicate: expectAliceSundanceUpdate,
    },
  ],
});
