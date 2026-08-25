/** Registers the maps service and discoverable maps action family. */

import type { Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { bindPromotedMapsSaveHandler, mapsAction } from "./action.js";
import { MAPS_VIEW_CAPABILITIES } from "./capabilities.js";
import { serverInteract } from "./interact.js";
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
  views: [
    {
      id: "maps",
      label: "Maps",
      description:
        "Explore places, compare route alternatives, and hand off map actions to Eliza.",
      icon: "Map",
      path: "/maps",
      order: 925,
      viewKind: "release",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "MapsView",
      surface: {
        header: "fullscreen",
        capabilities: ["agent-surface"],
      },
      tags: ["maps", "places", "routes", "navigation"],
      capabilities: MAPS_VIEW_CAPABILITIES,
      serverInteract,
      relatedActions: [
        "MAPS_PLACE",
        "MAPS_ROUTE",
        "MAPS_SAVE",
        "MAPS_SHARE",
        "MAPS_NAVIGATE",
      ],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default mapsPlugin;
