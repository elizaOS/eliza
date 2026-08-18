/** Registers the maps service and discoverable maps action family. */

import type { Action, Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { mapsAction } from "./action.js";
import { MapsService } from "./service.js";

const promotedMapsActions = promoteSubactionsToActions(mapsAction).map(
  (action): Action => {
    if (action.name === "MAPS_SAVE") {
      return {
        ...action,
        tags: [
          "domain:maps",
          "capability:write",
          "effect:idempotent",
          "effect:receipt-required",
        ],
      };
    }
    if (action.name === "MAPS") return action;
    return { ...action, tags: ["domain:maps", "capability:read"] };
  },
);

export const mapsPlugin: Plugin = {
  name: "maps",
  description:
    "Provider-neutral place search, routes, saved places, sharing, and navigation handoffs.",
  services: [MapsService],
  actions: promotedMapsActions,
};

export default mapsPlugin;
