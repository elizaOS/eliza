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

// Each operation says when to use it, in the words a user would use. Without
// this text a promoted action reads only `MAPS operation "route".`, and the
// planner cannot tell a route between two places from directions from here.
const promotedMapsActions = promoteSubactionsToActions(mapsAction, {
  overrides: {
    place: {
      description:
        "Find places by name, category or address: a coffee shop, a pharmacy, an address. For near me, nearest or nearby, set useCurrentLocation when the user gave no place to search around.",
      similes: ["FIND_PLACE", "NEARBY", "NEAREST", "NEAR_ME"],
    },
    route: {
      description:
        "Distance, travel time and alternatives between two places the user named, by drive, walk, bicycle or transit. For directions from where the user is now, use MAPS_NAVIGATION_START.",
      similes: ["HOW_FAR", "TRAVEL_TIME", "DIRECTIONS_BETWEEN"],
    },
    navigate: {
      description:
        "Hand one destination to navigation: the connected phone when it can take it now, otherwise a directions link.",
    },
  },
});
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

const promotedNavigationActions = promoteSubactionsToActions(
  mapsNavigationAction,
  {
    overrides: {
      start: {
        description:
          "Directions from where the user is now to a destination, by drive, walk, bicycle or transit. The phone plans the route from its own location and shows it; the user starts guidance.",
        similes: ["DIRECTIONS_FROM_HERE", "TAKE_ME_TO", "GET_ME_TO"],
      },
    },
  },
);
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
      // Saved places and routes are owner-private. The view follows the Notes
      // and Calendar precedent, which also keeps a host's native Maps navigable.
      roleGate: { minRole: "OWNER" },
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
        "MAPS_SAVED",
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
