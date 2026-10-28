/** Registers the maps service and discoverable maps action family. */

import type { Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import {
  bindPromotedMapsSaveHandler,
  mapsAction,
  mapsNavigationAction,
} from "./action.js";
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
  } else if (action.name === "MAPS_SELECT") {
    action.tags = ["domain:maps", "capability:device"];
  } else if (action.name !== "MAPS") {
    action.tags = ["domain:maps", "capability:read"];
  }
}

const promotedNavigationActions =
  promoteSubactionsToActions(mapsNavigationAction);
for (const action of promotedNavigationActions) {
  if (action.name !== "MAPS_NAVIGATION")
    action.tags = ["domain:maps", "capability:device"];
}

export const mapsPlugin: Plugin = {
  name: "maps",
  packageName: "@elizaos/plugin-maps",
  description:
    "Provider-neutral place search, routes, saved places, sharing, and navigation handoffs.",
  services: [MapsService],
  actions: [...promotedMapsActions, ...promotedNavigationActions],
  views: [
    {
      id: "maps",
      label: "Maps",
      description:
        "Explore places, compare route alternatives, and hand off map actions to Eliza.",
      icon: "Map",
      path: "/maps",
      responseContext: { primaryContext: "world" },
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
        "MAPS_SELECT",
        "MAPS_ROUTE",
        "MAPS_SAVE",
        "MAPS_SHARE",
        "MAPS_NAVIGATE",
        "MAPS_COVERAGE",
        "MAPS_NAVIGATION_START",
        "MAPS_NAVIGATION_REROUTE",
        "MAPS_NAVIGATION_STOP",
      ],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default mapsPlugin;
