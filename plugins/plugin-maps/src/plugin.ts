/** Registers the maps service and discoverable maps action family. */

import type { Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { bindPromotedMapsSaveHandler, mapsAction } from "./action.js";
import { MapsService } from "./service.js";

const promotedMapsActions = promoteSubactionsToActions(mapsAction);
for (const action of promotedMapsActions) {
  if (action.name === "MAPS_SAVE") {
    bindPromotedMapsSaveHandler(action);
    action.tags = [
      "domain:maps",
      "capability:write",
      "effect:idempotent",
      "effect:receipt-required",
    ];
  } else if (action.name !== "MAPS") {
    action.tags = ["domain:maps", "capability:read"];
  }
}

export const mapsPlugin: Plugin = {
  name: "maps",
  description:
    "Provider-neutral place search, routes, saved places, sharing, and navigation handoffs.",
  services: [MapsService],
  actions: [...promotedMapsActions],
};

export default mapsPlugin;
