/** Exercises the promoted Maps save action and durable coordinate state in the zero-credential scenario lane. */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "pr-deterministic",
  id: "maps.save-coordinate-deterministic",
  title: "Save a coordinate-defined place without a provider",
  domain: "maps",
  tags: ["maps", "saved-place", "deterministic", "receipt"],
  requires: { plugins: ["@elizaos/plugin-maps"] },
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Maps deterministic save",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "save-coordinate",
      actionName: "MAPS_SAVE",
      text: "Save Pike Place Market as Favorite.",
      options: {
        parameters: {
          action: "save",
          name: "Pike Place Market",
          address: "85 Pike Street, Seattle, WA 98101",
          latitude: 47.6097,
          longitude: -122.3425,
          label: "Favorite",
          idempotencyKey: "scenario-maps-save-pike-place",
        },
      },
      responseIncludesAll: ["Saved", "Favorite"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "MAPS_SAVE",
      status: "success",
      minCount: 1,
    },
  ],
});
