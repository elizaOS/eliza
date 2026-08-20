/**
 * Registers the maps service, the discoverable maps action family, and the
 * routed /maps web view with its read-only capability broker.
 */

import type { Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { bindPromotedMapsSaveHandler, mapsAction } from "./action.js";
import { MAPS_VIEW_CAPABILITIES } from "./capabilities.js";
import { serverInteract } from "./interact.js";
import { mapsRoutes } from "./routes.js";
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
  routes: mapsRoutes,
  views: [
    {
      id: "maps",
      label: "Maps",
      roleGate: { minRole: "OWNER" },
      description:
        "Place search, route alternatives, and the owner's saved places on a rendered map.",
      icon: "Map",
      path: "/maps",
      order: 930,
      viewKind: "release",
      modalities: ["gui"],
      tags: ["maps", "places", "directions", "routes", "navigation"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "MapsView",
      surface: { header: "fullscreen" },
      relatedActions: [
        "MAPS",
        "MAPS_PLACE",
        "MAPS_ROUTE",
        "MAPS_SAVE",
        "MAPS_SHARE",
        "MAPS_NAVIGATE",
      ],
      capabilities: MAPS_VIEW_CAPABILITIES,
      serverInteract,
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default mapsPlugin;
