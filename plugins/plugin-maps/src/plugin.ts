/** Registers the maps service and discoverable maps action family. */

import type { ContextDefinition, Memory, Plugin } from "@elizaos/core";
import {
  promoteSubactionsToActions,
  registerDirectActionRoutingRule,
} from "@elizaos/core";
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
        "Hand one destination to navigation: the connected phone when it can take it now, otherwise a directions link. For the nearest or a nearby kind of place, set useCurrentLocation.",
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
          "Directions from where the user is now to a destination, by drive, walk, bicycle or transit. The phone plans the route from its own location and shows it; the user starts guidance. For the nearest or a nearby kind of place (nearest pharmacy), set useCurrentLocation: the phone finds it around its own position.",
        similes: ["DIRECTIONS_FROM_HERE", "TAKE_ME_TO", "GET_ME_TO"],
      },
    },
  },
);
for (const action of promotedNavigationActions) {
  if (action.name !== "MAPS_NAVIGATION")
    action.tags = ["domain:maps", "capability:device"];
}

/**
 * Stage 1 classifies a turn into registered contexts. The Maps families used
 * to declare only "location" and "travel", which no plugin registers, so Stage
 * 1 could never name a context that exposes MAPS_*: on the phone "directions
 * to Coit Tower" became `general` + VIEWS_SHOW (Maps opened with no route), and
 * a discovery query naming "maps" was scoped to the only action declaring that
 * word, DEVICE_MAPS_READ_SELECTED (2026-11-18). The context id is the word
 * users and the view registry already use.
 */
export const MAPS_CONTEXT: ContextDefinition = {
  id: "maps",
  aliases: ["map", "location", "travel", "directions"],
  label: "Maps",
  description:
    "Places, addresses, nearby search, directions, routes, travel time and navigation.",
  descriptionCompressed: "Places, nearby search, directions and routes.",
  sensitivity: "personal",
  cacheScope: "agent",
  roleGate: { minRole: "OWNER" },
};

const COURTESY = String.raw`(?:(?:please|hey|ok(?:ay)?|so)[,\s]+)*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`;
// "the way to" is left out: "find the way to fix this bug" is not Maps work,
// and a simple Stage-1 answer would otherwise be forced into a Maps tool turn.
const TRAVEL_MODE = String.raw`(?:driving|walking|cycling|bike|transit)`;
const DIRECTIONS_NOUN = String.raw`(?:(?:${TRAVEL_MODE}\s+)?directions|(?:a\s+|the\s+)?(?:${TRAVEL_MODE}\s+)?route)`;
// A bare "route to X" is as often a software or network route ("route to the
// database"), so the bare form takes "route" only with a travel mode.
const BARE_DIRECTIONS_NOUN = String.raw`(?:(?:${TRAVEL_MODE}\s+)?directions|${TRAVEL_MODE}\s+route)`;
/**
 * "directions to assemble the shelf", "directions to fix the sink": a verb
 * after to/from names a task, not a place. "get to"/"get there" still travel.
 */
const NOT_A_PLACE = String.raw`(?!(?:assemble|fix|set\s*up|make|bake|cook|install|use|do|build|repair|configure|connect|clean|change|create|write|solve|reset|update|apply|start|finish|play|draw|prepare|replace|remove|open|turn|run|register|sign|log|download|upload|edit|format|cancel|enable|disable|add|plant|grow|knit|sew|paint|wire|mount|hang|unlock|pair|sync|export|import|get(?!\s+(?:to|there|home|back)\b))\b)`;
/** "to X", or "from A to B": a lone "from X" is a source ("from the manual"). */
const DESTINATION = String.raw`(?:to\s+${NOT_A_PLACE}\S|from\s+${NOT_A_PLACE}\S.*?\s+to\s+${NOT_A_PLACE}\S)`;
/**
 * "directions to X", "get me directions from A to B". "Take me to", "navigate
 * to" and "how do I get to" are left to the planner: they also name views
 * (view-navigation declines its Maps-view shortcut for them).
 */
const DIRECTIONS_REQUEST = new RegExp(
  [
    // A bare request: "directions to X", "walking route from A to B".
    String.raw`^\s*${COURTESY}${BARE_DIRECTIONS_NOUN}\s+${DESTINATION}`,
    // An asked-for one: "get me (the) directions to X".
    String.raw`^\s*${COURTESY}(?:get|give|show|find|pull\s+up)\s+(?:me\s+)?(?:(?:the|some)\s+)?${DIRECTIONS_NOUN}\s+${DESTINATION}`,
  ].join("|"),
  "iu",
);
/** "show the Ferry Building on the map", "find Coit Tower on maps". */
const PLACE_ON_MAP_REQUEST = new RegExp(
  String.raw`^\s*${COURTESY}(?:show|find|locate|pin|put)\s+(?:me\s+)?\S.*?\s+on\s+(?:the\s+|a\s+)?maps?\s*[.!?]?\s*$`,
  "iu",
);

export function isMapsDirectionsRequest(text: string): boolean {
  return DIRECTIONS_REQUEST.test(text);
}
export function isMapsPlaceOnMapRequest(text: string): boolean {
  return PLACE_ON_MAP_REQUEST.test(text);
}

/**
 * These routes replace a simple Stage-1 answer, so they claim only the owner's
 * own phone chat, as the camera and browser routes do; elsewhere the planner
 * keeps its judgment.
 */
function ownerChatTurn(message: Memory | undefined): boolean {
  return (
    message?.content.source === "client_chat" &&
    ["DM", "VOICE_DM"].includes(String(message.content.channelType))
  );
}

export const mapsPlugin: Plugin = {
  name: "maps",
  packageName: "@elizaos/plugin-maps",
  description:
    "Provider-neutral place search, routes, saved places, sharing, and navigation handoffs.",
  contexts: ["maps"],
  async init(_config, runtime) {
    runtime.contexts.tryRegister(MAPS_CONTEXT);
    // A directions request is Maps work, not a view switch. Stage 1 judged
    // "directions to Coit Tower" as direct navigation, so only VIEWS_SHOW ran
    // and the map showed no route. These owners replace a VIEWS-only
    // candidate; the view-navigation evaluator still adds VIEWS back when the
    // user also asked for a view, and the planner keeps full authority.
    registerDirectActionRoutingRule(runtime, {
      id: "maps.directions",
      actionNames: ["MAPS_ROUTE", "MAPS_NAVIGATION_START"],
      replacesActionNames: ["VIEWS", "VIEWS_SHOW"],
      requiredActionTags: ["domain:maps"],
      contexts: ["maps"],
      matches: (text, message) =>
        ownerChatTurn(message) && isMapsDirectionsRequest(text),
    });
    registerDirectActionRoutingRule(runtime, {
      id: "maps.place-on-map",
      actionNames: ["MAPS_SELECT", "MAPS_PLACE"],
      replacesActionNames: ["VIEWS", "VIEWS_SHOW"],
      requiredActionTags: ["domain:maps"],
      contexts: ["maps"],
      matches: (text, message) =>
        ownerChatTurn(message) && isMapsPlaceOnMapRequest(text),
    });
  },
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
    },
  ],
};

export default mapsPlugin;
