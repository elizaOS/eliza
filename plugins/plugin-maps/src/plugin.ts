/** Registers the maps service and discoverable maps action family. */

import type { Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { mapsAction } from "./action.js";
import { MapsService } from "./service.js";

export const mapsPlugin: Plugin = {
  name: "maps",
  description:
    "Provider-neutral place search, routes, saved places, sharing, and navigation handoffs.",
  services: [MapsService],
  actions: [...promoteSubactionsToActions(mapsAction)],
};

export default mapsPlugin;
