/** Registers the maps service and discoverable maps action family. */

import type { ContextDefinition, Memory, Plugin } from "@elizaos/core";
import {
  containsResourceAddress,
  namesViewNavigationTarget,
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
import {
  chosenPlace,
  PLACE_CHOICE_ACTIONS,
  type PlaceChoiceOperation,
} from "./place-choice.js";
import { MAPS_SERVICE_TYPE, MapsService } from "./service.js";

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
 * to" and "how do I get to" also name views; they are the travel route below.
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

/** A spoken travel or nearby request is short; longer text keeps the planner path. */
const MAX_TRAVEL_REQUEST_LENGTH = 160;
/** Trailing courtesy and punctuation: "..., please?", "... for me." */
const END = String.raw`(?:,?\s+(?:please|for\s+me))*\s*[.!?]*\s*$`;
/**
 * "take me to X", "navigate to X", "how do I get to X". X may still be a view
 * ("take me to settings"), which the caller checks against the view registry.
 */
const TRAVEL_TO_REQUEST = new RegExp(
  String.raw`^\s*${COURTESY}(?:(?:take|bring|get)\s+me|navigate(?:\s+me)?|how\s+(?:do|can|would|should)\s+(?:i|we)\s+get|how\s+to\s+get|what(?:'s|’s|\s+is)\s+the\s+(?:best|fastest|quickest)\s+way\s+to\s+get)\s+to\s+${NOT_A_PLACE}(?!(?:the\s+)?(?:next|previous|last|first|top|bottom|end|beginning|start|middle|same|other|point|know|sleep)\b)(\S.{0,79}?)${END}`,
  "iu",
);
/** A destination that is part of an app, a document or a conversation. */
const NOT_A_PLACE_DESTINATION =
  /\b(?:page|screen|tab|menu|view|section|step|level|folder|file|settings?|options?|line|slide|chapter|stage|part|item|message|email|thread|inbox|chat|conversation|document|doc|link|website|site)$/iu;
/** "then text Sam", "if it's open": further work or a condition keeps the planner path. */
const COMPOUND_REQUEST = /\b(?:then|if|unless|when|once)\b/iu;
/** "1 Market St, San Francisco, CA 94105": the only commas a destination keeps. */
const STREET_ADDRESS_WITH_LOCALITY =
  /^\d+[a-z]?\s+[^,]+(?:,\s*[\p{Lu}\d][\p{L}\d.'’ -]*)+$/u;

function compoundDestination(destination: string): boolean {
  return (
    COMPOUND_REQUEST.test(destination) ||
    (destination.includes(",") &&
      !STREET_ADDRESS_WITH_LOCALITY.test(destination))
  );
}

/** The destination of a travel request from the user's position, if it is one. */
export function mapsTravelDestination(text: string): string | undefined {
  if (text.length > MAX_TRAVEL_REQUEST_LENGTH) return;
  const destination = TRAVEL_TO_REQUEST.exec(text)?.[1]?.trim();
  if (
    !destination ||
    NOT_A_PLACE_DESTINATION.test(destination) ||
    compoundDestination(destination) ||
    containsResourceAddress(destination)
  )
    return;
  return destination;
}

/**
 * "nearest neighbor", "round to the nearest dollar", "the closest integer":
 * a nearest or closest that is not a kind of place.
 */
const NOT_A_PLACE_KIND = String.raw`(?!(?:neighbou?rs?|integers?|whole|numbers?|dollars?|cents?|penn(?:y|ies)|hundreds?|thousands?|millions?|tens?|tenths?|hundredths?|thousandths?|decimals?|minutes?|hours?|seconds?|days?|weeks?|months?|years?|multiples?|powers?|points?|values?|match(?:es)?|percent|degrees?|units?|digits?|fractions?|primes?|pairs?|stars?|planets?|galax(?:y|ies)|matches|relatives?|synonyms?|words?|colou?rs?|versions?|results?)\b)`;
/**
 * "go to X" names an app, a document or a conversation far more often than a
 * place ("go to the top", "go to page 3", "go to sleep", "go to my inbox"), so
 * only a named place or a street address counts: "go to Coit Tower", "go to
 * the Ferry Building", "go to 1 Market St, San Francisco".
 */
const GO_TO_REQUEST = new RegExp(
  String.raw`^\s*${COURTESY}(?:let(?:'s|’s|\s+us)\s+)?go\s+to\s+(\S.{0,79}?)${END}`,
  "iu",
);
/**
 * A first word that is an app, document or calendar position, or a well-known
 * site or app rather than a place: "go to Line 40", "go to Definition", "go to
 * the Next Slide", "go to Google Drive", "go to Monday".
 */
const GO_TO_NOT_A_PLACE =
  /^(?:(?:my|your|our|his|her|their|its|this|that|these|those)\b|(?:next|previous|prev|last|first|top|bottom|end|beginning|start|middle|same|other|point|sleep|bed|definition|declaration|implementation|references?|symbol|usages?|line|page|slide|chapter|section|step|level|tab|item|row|column|cell|sheet|folder|file|message|email|thread|inbox|chat|settings?|preferences|google|gmail|youtube|facebook|instagram|twitter|reddit|wikipedia|amazon|netflix|spotify|github|slack|discord|whatsapp|tiktok|linkedin|chrome|safari|firefox|outlook|today|tomorrow|yesterday|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b)/iu;
/** "Coit Tower", "McDonald's", "O'Hare": a capitalised word, not an acronym or code ("Q3"). */
const PROPER_NAME = /^\p{Lu}[\p{Ll}'’]/u;
/**
 * A lone capitalised word can name a person or app. Recognise a small set of
 * retail, hospitality and fuel chains with physical locations. Other names
 * stay with the planner unless the user says "take me to" or "navigate to".
 */
const SINGLE_TOKEN_BUSINESS_NAMES = new Set([
  "7-eleven",
  "albertsons",
  "aldi",
  "applebees",
  "arbys",
  "arco",
  "carrefour",
  "chevron",
  "chilis",
  "chipotle",
  "costco",
  "dennys",
  "dunkin",
  "exxon",
  "familymart",
  "h&m",
  "hilton",
  "hyatt",
  "ikea",
  "in-n-out",
  "kmart",
  "kohls",
  "kroger",
  "lawson",
  "lidl",
  "lowes",
  "macys",
  "marriott",
  "mcdonalds",
  "meijer",
  "nordstrom",
  "panera",
  "peets",
  "petco",
  "petsmart",
  "popeyes",
  "publix",
  "safeway",
  "sephora",
  "sheraton",
  "staples",
  "starbucks",
  "target",
  "tesco",
  "texaco",
  "ulta",
  "uniqlo",
  "valero",
  "walgreens",
  "walmart",
  "wegmans",
  "wendys",
  "westin",
  "yodobashi",
  "zara",
]);
/**
 * "SFO", "JFK Terminal 4", "UCSF Medical Center": an all-caps code of two to
 * five letters, unless it is a common file, software or time abbreviation.
 */
const PLACE_CODE =
  /^(?!(?:PDF|FAQ|URL|API|TODO|HTML|CSS|JSON|XML|SQL|CSV|USB|TV|AM|PM|OK|ASAP|FYI|AI|ML|UI|UX|IT|HR|PR|CI|QA|SDK|CLI|GUI|OS|AWS|VPN|DNS|SSH|IDE|DM|DMS|SMS|MMS|BIOS)\b)\p{Lu}{2,5}(?=\s|$)/u;
/** "market street", "1600 pennsylvania avenue": an unambiguous street suffix. */
const STREET_NAME =
  /\p{L}\s+(?:street|st|avenue|ave|boulevard|blvd|road|rd|lane|ln|parkway|pkwy|highway|hwy)\.?(?:,|$)/iu;
/** "1 Market St", "221b Baker Street", "500 howard street". */
const STREET_ADDRESS =
  /^\d+[a-z]?\s+(?:\p{Lu}|\S+.*?\b(?:drive|dr|way|place|pl|court|ct|terrace|square|plaza|circle)\.?(?:,|$))/u;

/**
 * A venue in a spoken place name ("coit tower", "museum of modern art") or
 * following a code ("JFK Terminal 4") is affirmative evidence of travel.
 */
const PLACE_NAME_CUE =
  /^(?:cathedral|college|museum|university)\s+of\s+\p{L}|\b(?:airport|aquarium|beach|bridge|building|caf[eé]|cathedral|center|centre|cinema|clinic|college|court|garden|hospital|hotel|library|market|museum|park|pharmacy|pier|plaza|restaurant|shop|square|stadium|station|store|terminal|theat(?:er|re)|tower|trail|university|zoo)(?:\s+\d+[a-z]?)?$/iu;

const SPOKEN_NOT_A_PLACE_IDIOM =
  /^(?:sleep|bed|work|school|church|war|waste|town|pieces|great\s+lengths)\b/u;
/** "go to the right place", "go to see a movie", "go to the second floor". */
const SPOKEN_NOT_A_PLACE_FIRST_WORD =
  /^(?:right|wrong|left|main|current|latest|original|default|following|above|below|more|less|all|any|some|every|each|no|one|two|three|second|third|fourth|fifth|see|watch|pick|check|look|find|buy|grab|eat|drink|meet|visit|help|talk|ask|tell|say|take|bring|go|come|stay|lunch|dinner|breakfast|brunch|class|practice|rehearsal|apple|microsoft|app|apps|play|android|iphone|ios|windows|mac|phone|device|system|control|bing|yahoo|duckduckgo)\b/u;
/** A word that makes the phrase about someone, something, a time or more work. */
const SPOKEN_NOT_A_PLACE_WORD =
  /\b(?:i|me|my|mine|you|your|yours|we|us|our|he|him|his|she|her|they|them|their|it|its|this|that|these|those|today|tomorrow|tonight|yesterday|now|later|soon|morning|afternoon|evening|weekend|with|for|and|or|but|so|to|about|after|before|without|because|until|while)\b/u;
/** "go to the nearest gas station", but not "go to the nearest integer". */
const SPOKEN_NEAREST = /^(?:nearest|closest)\b/u;
const SPOKEN_NEAREST_PLACE = new RegExp(
  String.raw`^(?:nearest|closest)\s+${NOT_A_PLACE_KIND}`,
  "u",
);

/** A lowercase destination that still reads as a place: "coit tower", "the ferry building". */
function spokenPlaceName(name: string): boolean {
  return (
    /^\p{Ll}/u.test(name) &&
    /\s/u.test(name) &&
    PLACE_NAME_CUE.test(name) &&
    !SPOKEN_NOT_A_PLACE_IDIOM.test(name) &&
    !SPOKEN_NOT_A_PLACE_FIRST_WORD.test(name) &&
    !SPOKEN_NOT_A_PLACE_WORD.test(name) &&
    (!SPOKEN_NEAREST.test(name) || SPOKEN_NEAREST_PLACE.test(name))
  );
}

/**
 * The place a "go to X" request names, if it names a place or a street
 * address. A capitalised name needs two words, "the" ("the Presidio") or a
 * well-known chain; a lone "Sam" or "Notion" is left to the planner.
 */
export function mapsGoToDestination(text: string): string | undefined {
  if (text.length > MAX_TRAVEL_REQUEST_LENGTH) return;
  const destination = GO_TO_REQUEST.exec(text)?.[1]?.trim();
  if (!destination) return;
  const name = destination.replace(/^the\s+/iu, "");
  const code = PLACE_CODE.exec(name)?.[0];
  if (
    GO_TO_NOT_A_PLACE.test(name) ||
    NOT_A_PLACE_DESTINATION.test(destination) ||
    compoundDestination(destination) ||
    containsResourceAddress(destination) ||
    !(
      SINGLE_TOKEN_BUSINESS_NAMES.has(
        name.toLowerCase().replace(/['’]/gu, ""),
      ) ||
      (PROPER_NAME.test(name) && (name !== destination || /\s/u.test(name))) ||
      (code !== undefined &&
        (code === name ||
          (PLACE_NAME_CUE.test(name) &&
            !SPOKEN_NOT_A_PLACE_WORD.test(name.toLowerCase())))) ||
      STREET_ADDRESS.test(name) ||
      STREET_NAME.test(name) ||
      spokenPlaceName(name)
    )
  )
    return;
  return destination;
}

const FIND_VERB = String.raw`(?:(?:find|show|locate|get|search\s+for|look\s+(?:for|up))\s+(?:me\s+)?|where(?:'s|’s|\s+is|\s+are)\s+|what(?:'s|’s|\s+is)\s+)`;
/** "find the nearest pharmacy", "nearest coffee shop", "where is the closest gas station?" */
const NEAREST_PLACE_REQUEST = new RegExp(
  String.raw`^\s*${COURTESY}${FIND_VERB}?(?:(?:the|a|my)\s+)?(?:nearest|closest)\s+${NOT_A_PLACE_KIND}[\p{L}'’&-]+(?:\s+[\p{L}'’&-]+){0,4}${END}`,
  "iu",
);
const PLACE_KIND = String.raw`(?:(?:a|an|some|any)\s+)?[\p{L}'’&-]+(?:\s+[\p{L}'’&-]+){0,3}`;
const NEARBY = String.raw`(?:near\s+(?:me|here|by)|nearby|around\s+here|close\s+by)`;
/** "is there anyone nearby", "is there a way around here": not a kind of place. */
const NOT_A_PLACE_THERE = String.raw`(?!(?:anyone|anybody|someone|somebody|no\s?one|nobody|one|(?:a|any)\s+(?:way|chance|reason|problem|issue|bug|error|difference|need|point))\b)`;
/**
 * "find a pharmacy nearby", "coffee shops near me", "is there a pharmacy near
 * me?", "where can I get coffee nearby?", "any good tacos around here?".
 * Without a search verb or question only "near me" counts, and not after a
 * verb or pronoun ("stay near me", "I'm nearby"). Nothing may follow the
 * nearness ("is there anything near me in my calendar").
 */
const PLACE_NEAR_ME_REQUEST = new RegExp(
  [
    String.raw`^\s*${COURTESY}${FIND_VERB}${PLACE_KIND}\s+${NEARBY}${END}`,
    String.raw`^\s*${COURTESY}(?:is|are)\s+there\s+${NOT_A_PLACE_THERE}${PLACE_KIND}\s+${NEARBY}${END}`,
    String.raw`^\s*${COURTESY}where\s+(?:can|could|should|do)\s+(?:i|we)\s+(?:get|find|buy|grab)\s+${PLACE_KIND}\s+${NEARBY}${END}`,
    String.raw`^\s*${COURTESY}(?:any|some)\s+[\p{L}'’&-]+(?:\s+[\p{L}'’&-]+){0,3}\s+${NEARBY}${END}`,
    String.raw`^\s*${COURTESY}(?!(?:stay|sit|come|be|keep|stand|get|move|go|walk|park|i|i'm|i’m|im|you|he|she|they|we|it|is|are|was|were)\b)${PLACE_KIND}\s+near\s+me${END}`,
  ].join("|"),
  "iu",
);

/** A search for the nearest or a nearby kind of place, from the user's position. */
export function isMapsNearbyPlaceRequest(text: string): boolean {
  return (
    text.length <= MAX_TRAVEL_REQUEST_LENGTH &&
    (NEAREST_PLACE_REQUEST.test(text) || PLACE_NEAR_ME_REQUEST.test(text))
  );
}

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

/**
 * The operation whose "which one did you mean?" question this owner turn
 * answers ("the first one"), if one is open in this conversation.
 */
function answeredPlaceChoice(
  runtime: Parameters<NonNullable<Plugin["init"]>>[1],
  text: string,
  message: Memory | undefined,
): PlaceChoiceOperation | undefined {
  if (!message) return undefined;
  const service = runtime.getService(MAPS_SERVICE_TYPE);
  if (!(service instanceof MapsService)) return undefined;
  // Looked up for every owner turn, so a turn that moves on closes the
  // question and a later "the first one" is left to whatever asked it.
  const choice = service.placeChoices.get(message);
  return choice && chosenPlace(choice, text) ? choice.operation : undefined;
}

/**
 * A travel destination that names no registered view. Without a host view
 * registry a view cannot be told from a place, so the route stays out.
 */
function travelToPlace(
  runtime: Parameters<NonNullable<Plugin["init"]>>[1],
  text: string,
  message: Memory | undefined,
  destinationOf: (text: string) => string | undefined = mapsTravelDestination,
): boolean {
  const destination = destinationOf(text);
  return (
    destination !== undefined &&
    namesViewNavigationTarget(runtime, destination, message) === false
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
    // "take me to Coit Tower", "how do I get to Golden Gate Park": travel from
    // here. Stage 1 often answers these with a simple reply, so nothing reached
    // Maps; a destination that names a view ("take me to settings") stays view
    // navigation.
    registerDirectActionRoutingRule(runtime, {
      id: "maps.travel-to",
      actionNames: ["MAPS_NAVIGATION_START", "MAPS_ROUTE"],
      replacesActionNames: ["VIEWS", "VIEWS_SHOW"],
      requiredActionTags: ["domain:maps"],
      contexts: ["maps"],
      matches: (text, message) =>
        ownerChatTurn(message) && travelToPlace(runtime, text, message),
    });
    // "go to Coit Tower", "go to 1 Market St, San Francisco": the same travel,
    // for a named place or street address only. "go to settings", "go to
    // Photos" stay view navigation, and "go to the top" or "go to sleep" keep
    // the planner's answer.
    registerDirectActionRoutingRule(runtime, {
      id: "maps.go-to-place",
      actionNames: ["MAPS_NAVIGATION_START", "MAPS_ROUTE"],
      replacesActionNames: ["VIEWS", "VIEWS_SHOW"],
      requiredActionTags: ["domain:maps"],
      contexts: ["maps"],
      matches: (text, message) =>
        ownerChatTurn(message) &&
        travelToPlace(runtime, text, message, mapsGoToDestination),
    });
    // "the first one" answers the open "which one did you mean?" question.
    // Without this the reply reads as small talk: on the phone (v610) Stage 1
    // answered it in prose ("I can't load a live route from here") and no
    // route was planned. The operation that asked continues the request.
    for (const [operation, actionName] of Object.entries(
      PLACE_CHOICE_ACTIONS,
    ) as [PlaceChoiceOperation, string][]) {
      registerDirectActionRoutingRule(runtime, {
        id: `maps.place-choice.${operation}`,
        actionNames: [actionName],
        replacesActionNames: ["VIEWS", "VIEWS_SHOW"],
        requiredActionTags: ["domain:maps"],
        contexts: ["maps"],
        matches: (text, message) =>
          ownerChatTurn(message) &&
          answeredPlaceChoice(runtime, text, message) === operation,
      });
    }
    // "find the nearest pharmacy": the place search around the phone's own
    // position (a locate card), or directions to it.
    registerDirectActionRoutingRule(runtime, {
      id: "maps.nearby-place",
      actionNames: ["MAPS_PLACE", "MAPS_NAVIGATION_START"],
      replacesActionNames: ["VIEWS", "VIEWS_SHOW"],
      requiredActionTags: ["domain:maps"],
      contexts: ["maps"],
      matches: (text, message) =>
        ownerChatTurn(message) && isMapsNearbyPlaceRequest(text),
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
