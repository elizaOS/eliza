/** Implements the MAPS umbrella and its promoted place, route, save, share, and navigation actions. */

import { randomUUID } from "node:crypto";
import type {
  Action,
  ActionResult,
  ChoiceInteraction,
  EffectReceipt,
  FormInteraction,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  appendInteractionBlock,
  hasOwnerAccess,
  requireConfirmation,
} from "@elizaos/core";
import {
  appendMapsCard,
  handoffCard,
  MAPS_CARD_MAX_PLACES,
  type MapsLocateCard,
  routeCard,
  toCardPlace,
} from "./card.js";
import { describeMapsCoverage, offeredTravelModes } from "./coverage.js";
import { MapsError } from "./errors.js";
import type {
  MapsDeviceNavigation,
  MapsDeviceNavigationStatus,
} from "./navigation.js";
import {
  chosenPlace,
  dominantPlace,
  metersBetween,
  type PendingPlaceChoice,
  type PlaceChoiceField,
  type PlaceChoiceOperation,
  placeLabel,
} from "./place-choice.js";
import { getMapsService, type MapsService } from "./service.js";
import {
  coordinatesSchema,
  type PlaceRef,
  placeRefSchema,
  type RoutePlan,
  type TravelMode,
  travelModeSchema,
} from "./types.js";

const MAPS_SUBACTIONS = [
  "place",
  "select",
  "route",
  "save",
  "share",
  "navigate",
  "coverage",
  "saved",
] as const;
type MapsSubaction = (typeof MAPS_SUBACTIONS)[number];
const MAPS_SAVE_VIRTUAL_EXECUTION = Symbol(
  "plugin-maps.promoted-save-execution",
);

type Params = Record<string, unknown> & { action?: MapsSubaction };

function parameters(message: Memory, options?: HandlerOptions): Params {
  const values: Record<string, unknown> = {
    ...((options?.parameters ?? {}) as Record<string, unknown>),
  };
  if (message.content && typeof message.content === "object") {
    for (const [key, value] of Object.entries(message.content)) {
      if (values[key] === undefined) values[key] = value;
    }
  }
  return values as Params;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function opaqueText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function flag(value: unknown): boolean {
  return value === true || value === "true";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function validated<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: unknown };
  },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new MapsError(message, {
      code: "MAPS_INVALID_INPUT",
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function normalizeAction(value: unknown): MapsSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return MAPS_SUBACTIONS.includes(normalized as MapsSubaction)
    ? (normalized as MapsSubaction)
    : null;
}

async function result(
  action: MapsSubaction,
  value: ActionResult,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  await callback?.({
    text: value.userFacingText ?? value.text,
    actions: [`MAPS_${action.toUpperCase()}`],
  });
  return value;
}

function missingInput(
  action: MapsSubaction,
  message: Memory,
  fields: FormInteraction["fields"],
  prompt: string,
): ActionResult {
  const form: FormInteraction = {
    kind: "form",
    id: `maps-${action}-${String(message.id ?? "request")}`,
    title: `${action[0]?.toUpperCase()}${action.slice(1)} with Maps`,
    description: prompt,
    submitLabel: "Continue",
    fields,
  };
  const userFacingText = appendInteractionBlock(prompt, form);
  return {
    success: false,
    text: prompt,
    userFacingText,
    verifiedUserFacing: true,
    data: {
      actionName: "MAPS",
      action,
      reason: "missing_input",
      awaitingUserInput: true,
      missingFields: fields
        .filter((field) => field.required)
        .map((field) => field.name),
      uiRequest: form,
    },
  };
}

/**
 * The request referenced the user's current position but supplied no
 * coordinates: hand the surface a locate card so it can collect a precise
 * device location behind the platform permission prompt. Coordinates are never
 * fabricated server-side.
 */
function awaitingLocation(
  action: MapsSubaction,
  intent: MapsLocateCard["intent"],
  prompt: string,
  subject: Pick<MapsLocateCard, "query" | "destination" | "travelMode">,
  /** What the owner can say instead when the phone has no fix; the card keeps the prompt alone. */
  instead?: string,
): ActionResult {
  const reply = instead ? `${prompt} ${instead}` : prompt;
  const userFacingText = appendMapsCard(reply, {
    kind: "locate",
    intent,
    prompt,
    ...subject,
  });
  return {
    success: false,
    text: reply,
    userFacingText,
    verifiedUserFacing: true,
    data: {
      actionName: "MAPS",
      action,
      reason: "missing_location",
      awaitingUserInput: true,
    },
  };
}

/**
 * Sharing a location waits for the user's own reply to this prompt. Core binds
 * the pending consent to the place and ignores the message that asked, so a
 * model turn can never disclose coordinates without the user's visible consent.
 */
function shareConfirmation(message: Memory, place: PlaceRef): ActionResult {
  const prompt = `Share the location of ${place.name}?`;
  const choice: ChoiceInteraction = {
    kind: "choice",
    id: `maps-share-${String(message.id ?? "request")}`,
    scope: "maps-share",
    prompt,
    options: [
      {
        value: `Yes, share the location of ${place.name} (confirmed).`,
        label: "Share location",
      },
      { value: "No, do not share my location.", label: "Don't share" },
    ],
  };
  return {
    success: false,
    text: prompt,
    userFacingText: appendInteractionBlock(prompt, choice),
    verifiedUserFacing: true,
    data: {
      actionName: "MAPS",
      action: "share",
      reason: "confirmation_required",
      awaitingUserInput: true,
      place: toCardPlace(place),
    },
  };
}

const TRAVEL_MODE_LABEL: Record<TravelMode, string> = {
  drive: "Drive",
  walk: "Walk",
  bicycle: "Bicycle",
  transit: "Transit",
};

/** The travel-mode choice offers only modes the provider serves; transit only where reported. */
function travelModeField(
  modes: readonly TravelMode[],
): FormInteraction["fields"][number] {
  return {
    name: "travelMode",
    type: "select",
    label: "Travel mode",
    required: false,
    options: modes.map((value) => ({
      value,
      label: TRAVEL_MODE_LABEL[value],
    })),
  };
}

/**
 * Modes the provider reports. An unreported or unreadable coverage narrows
 * nothing: a malformed coverage fact never refuses a route (README).
 */
async function servedTravelModes(
  service: MapsService,
  provider?: string,
): Promise<TravelMode[]> {
  try {
    return offeredTravelModes(
      (await service.coverageResult(provider)).coverage,
    );
  } catch (error) {
    if (error instanceof MapsError) return offeredTravelModes(null);
    throw error;
  }
}

/** Refuses transit before dispatch when the provider's reported coverage omits it. */
async function assertTransitServed(
  service: MapsService,
  travelMode: TravelMode,
  provider?: string,
): Promise<void> {
  if (travelMode !== "transit") return;
  if ((await servedTravelModes(service, provider)).includes("transit")) return;
  throw new MapsError("This Maps provider does not serve transit routes.", {
    code: "MAPS_UNSUPPORTED_REGION",
    context: { travelMode },
  });
}

function directPlace(params: Params, prefix = ""): PlaceRef | null {
  const field = (name: string) =>
    `${prefix}${prefix ? name[0]?.toUpperCase() : name[0]}${name.slice(1)}`;
  const latitude = number(params[field("latitude")]);
  const longitude = number(params[field("longitude")]);
  const name = text(params[field("name")]);
  const hasDirectInput =
    params[field("latitude")] !== undefined ||
    params[field("longitude")] !== undefined ||
    params[field("name")] !== undefined;
  if (!hasDirectInput) return null;
  if (latitude === undefined || longitude === undefined || !name) {
    throw new MapsError(
      `Coordinate-defined places require ${field("latitude")}, ${field("longitude")}, and ${field("name")} together.`,
      { code: "MAPS_INVALID_INPUT" },
    );
  }
  const coordinates = coordinatesSchema.safeParse({ latitude, longitude });
  if (!coordinates.success) {
    throw new MapsError(
      "Coordinates are outside the valid latitude/longitude range.",
      {
        code: "MAPS_INVALID_INPUT",
        cause: coordinates.error,
      },
    );
  }
  return validated(
    placeRefSchema,
    {
      provider: "coordinates",
      providerPlaceId: `coordinates:${latitude},${longitude}`,
      name,
      coordinates: coordinates.data,
      formattedAddress: text(params[field("address")]),
      categories: [],
    },
    "The coordinate-defined place is invalid.",
  );
}

async function resolvedPlace(
  service: MapsService,
  params: Params,
  ownerEntityId: string,
): Promise<PlaceRef | null> {
  const savedPlaceId = opaqueText(params.savedPlaceId);
  if (savedPlaceId) {
    return (
      (await service.getSavedPlace(ownerEntityId, savedPlaceId))?.place ?? null
    );
  }
  const placeId = opaqueText(params.placeId);
  if (placeId) return service.getPlace(placeId, text(params.provider));
  return directPlace(params);
}

const PLACE_QUERY_FIELD: FormInteraction["fields"][number] = {
  name: "placeQuery",
  type: "text",
  label: "Place (name or address)",
  required: true,
};

const ORIGIN_QUERY_FIELD: FormInteraction["fields"][number] = {
  name: "originQuery",
  type: "text",
  label: "Starting place (name or address)",
  required: true,
};

const DESTINATION_QUERY_FIELD: FormInteraction["fields"][number] = {
  name: "destinationQuery",
  type: "text",
  label: "Destination (name or address)",
  required: true,
};

function isReply(value: PlaceRef | ActionResult): value is ActionResult {
  return "success" in value;
}

/** The owner's own words this turn, which a choice reply binds from. */
function replyText(message: Memory): string | undefined {
  return text(message.content?.text);
}

/** How each field's question names what is being chosen. */
const CHOICE_QUESTION: Record<PlaceChoiceField, (query: string) => string> = {
  originQuery: (query) =>
    `Which “${query}” did you mean as the starting place?`,
  destinationQuery: (query) =>
    `Which “${query}” did you mean as the destination?`,
  placeQuery: () => "Which one did you mean?",
};

interface PlaceQueryOptions {
  provider?: string;
  /** The other route endpoint: a destination is looked for around the origin. */
  anchor?: PlaceRef | null;
  /** Context the question adds, such as the settled starting place. */
  note?: string;
}

/**
 * Resolves a typed name or address, returns numbered options for ambiguity,
 * or returns the plain not-found reply.
 */
async function placeFromQuery(
  service: MapsService,
  action: MapsSubaction,
  message: Memory,
  field: FormInteraction["fields"][number],
  query: string,
  options: PlaceQueryOptions = {},
): Promise<PlaceRef | ActionResult> {
  const name = field.name as PlaceChoiceField;
  // The provider biases the search around the other endpoint it returned. A
  // coordinate or another provider's place may lie outside its coverage.
  const anchor =
    options.anchor && options.anchor.provider !== "coordinates"
      ? options.anchor.coordinates
      : undefined;
  let searched: Awaited<ReturnType<MapsService["searchPlacesResult"]>>;
  try {
    searched = await service.searchPlacesResult(
      { query, limit: 5, ...(anchor ? { near: anchor } : {}) },
      options.provider,
    );
  } catch (error) {
    if (
      !anchor ||
      !(error instanceof MapsError) ||
      error.code !== "MAPS_UNSUPPORTED_REGION"
    )
      throw error;
    searched = await service.searchPlacesResult(
      { query, limit: 5 },
      options.provider,
    );
  }
  const { page, provider: searchProvider } = searched;
  if (page.places.length === 0) {
    return {
      success: false,
      text: "No matching place was found.",
      userFacingText: "No matching place was found.",
      verifiedUserFacing: true,
      data: { actionName: "MAPS", action, reason: "not_found", query },
    };
  }
  const meant = dominantPlace(query, page.places, options.anchor?.coordinates);
  if (meant) return meant;
  const ask = missingInput(
    action,
    message,
    [field],
    [
      CHOICE_QUESTION[name](query),
      ...(options.note ? [options.note] : []),
      ...page.places.map(
        (place, index) => `${index + 1}. ${placeLabel(place)}`,
      ),
    ].join("\n"),
  );
  return {
    ...ask,
    userFacingText: appendMapsCard(ask.userFacingText ?? ask.text ?? "", {
      kind: "places",
      query,
      places: page.places.slice(0, MAPS_CARD_MAX_PLACES).map(toCardPlace),
      nextCursor: null,
      attribution: searchProvider.attribution,
    }),
    data: {
      ...ask.data,
      places: page.places,
      choice: { field: name, query },
    },
  };
}

/** The open question a request of this operation may continue. */
function openChoice(
  service: MapsService,
  message: Memory,
  operation: PlaceChoiceOperation,
): PendingPlaceChoice | undefined {
  const choice = service.placeChoices.get(message);
  return choice?.operation === operation ? choice : undefined;
}

/** Records the question a reply asked, so the owner's answer binds to it. */
function rememberChoice(
  service: MapsService,
  message: Memory,
  operation: PlaceChoiceOperation,
  reply: ActionResult,
  context: Pick<PendingPlaceChoice, "queries" | "resolved" | "travelMode">,
): void {
  const data = reply.data as
    | {
        choice?: { field: PlaceChoiceField; query: string };
        places?: PlaceRef[];
      }
    | undefined;
  if (!data?.choice || !data.places) return;
  service.placeChoices.set(message, {
    operation,
    field: data.choice.field,
    query: data.choice.query,
    places: data.places,
    ...context,
  });
}

/** The travel mode the request named, if any. */
function namedTravelMode(params: Params): TravelMode | undefined {
  const mode = text(params.travelMode);
  return mode
    ? validated(
        travelModeSchema,
        mode,
        "Travel mode must be drive, walk, bicycle, or transit.",
      )
    : undefined;
}

/** "nearest pharmacy" → "pharmacy", for an example the owner can say back. */
function placeKind(query: string): string {
  return (
    query
      .replace(
        /^(?:(?:the|a|an|some|any)\s+)?(?:(?:nearest|closest)\s+)?/iu,
        "",
      )
      .trim() || query
  );
}

/** "pharmacy near the Ferry Building": a kind of place and the named place it is near. */
export interface AnchoredPlaceQuery {
  kind: string;
  anchor: string;
}

/**
 * Words after "near" that mean the owner's own position, not a named place:
 * "near me", "near me open now", "near us open now", "near by", "close to
 * where I am right now", "around midnight near me". After "us", only "now",
 * "right now" or "open now" may follow: "us bank tower" and "us 101" are places.
 */
const OWN_POSITION =
  /^(?:me|here)\b|^(?:us(?:,?\s+(?:open\s+)?(?:right\s+)?now)?|by|myself|this\s+(?:place|spot|location)|(?:my|the)\s+phone)$|^(?:my\s+(?:location|position|place|current\s+location)|where\s+(?:i|we)\s+(?:am|are)|current\s+location)\b|\b(?:near|around|close\s+to|next\s+to)\s+(?:me|here|us)$/iu;

/**
 * "around midnight", "near 5pm", "around Christmas", "near the end": a time
 * or a position in something, not a place to search around. "near home",
 * "near my office" name the owner's own places, which a provider search by
 * that word cannot find. A street address ("near 1 Market St") still counts.
 */
export const NEAR_NOT_A_PLACE =
  /^(?:home|work|the\s+office|(?:my|our)\s+.+|(?:the\s+)?(?:top|bottom|end|beginning|start|middle|deadline|weekend|holidays?)|midnight|noon|midday|dawn|dusk|sunrise|sunset|lunch(?:time)?|dinner(?:time)?|breakfast|christmas(?:\s+eve)?|thanksgiving|easter|halloween|new\s+year(?:'s|’s)?(?:\s+(?:eve|day))?|(?:mon|tues|wednes|thurs|fri|satur|sun)day|january|february|march|april|june|july|august|september|october|november|december|line\s+\d+|page\s+\d+|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.?|p\.m\.?|o'?clock)?)$/iu;

/**
 * Things the owner keeps on the phone, not kinds of places: "photos near the
 * Ferry Building" is a Photos search, "messages around Thanksgiving" a
 * Messages search.
 */
export const NEAR_NOT_A_PLACE_KIND =
  /\b(?:photos?|pictures?|pics?|images?|videos?|clips?|selfies?|screenshots?|e-?mails?|mail|messages?|texts?|chats?|notes?|files?|documents?|docs?|songs?|music|tracks?|albums?|playlists?|podcasts?|events?|meetings?|appointments?|reminders?|alarms?|contacts?|tasks?|to-?dos?|bugs?|issues?|errors?|lines?|comments?|posts?|tweets?|results?|calls?|voicemails?)$/iu;

const ANCHORED_QUERY =
  /^\s*(?:(?:please|can\s+you|could\s+you)\s+)*(?:(?:i|we)\s+(?:need|want)\s+|(?:i'?m|i’m|we'?re|we’re)\s+looking\s+for\s+)?(?:(?:find|show|search\s+for|look\s+for|look\s+up|locate|get)\s+(?:me\s+)?)?(?:(?:is|are)\s+there\s+)?(?:(?:the|a|an|some|any)\s+)?(?:(?:nearest|closest)\s+)?(.{1,80}?)\s+(?:near|around|close\s+to|next\s+to)\s+(.{1,120}?)(?:,?\s+(?:please|for\s+me))*[\s?.!]*$/iu;

/**
 * The named place a search is near ("pharmacy near the Ferry Building"), or
 * undefined for "near me" and for a query that names no place to search
 * around. Such a search needs no position from the phone.
 */
export function anchoredPlaceQuery(
  query: string,
): AnchoredPlaceQuery | undefined {
  const match = ANCHORED_QUERY.exec(query);
  const kind = match?.[1]?.trim();
  const anchor = match?.[2]?.trim();
  if (
    !kind ||
    !anchor ||
    OWN_POSITION.test(anchor) ||
    NEAR_NOT_A_PLACE.test(anchor) ||
    NEAR_NOT_A_PLACE_KIND.test(kind)
  )
    return undefined;
  return { kind, anchor };
}

/** The named place an anchored search is near, or the reply that it was not found. */
async function searchAnchor(
  service: MapsService,
  anchored: AnchoredPlaceQuery,
  params: Params,
): Promise<PlaceRef | ActionResult> {
  const { page } = await service.searchPlacesResult(
    { query: anchored.anchor, limit: 5 },
    text(params.provider),
  );
  const anchor =
    dominantPlace(anchored.anchor, page.places) ??
    (page.places.length === 1 ? page.places[0] : undefined);
  if (anchor) return anchor;
  const reply =
    page.places.length === 0
      ? `I couldn't find “${anchored.anchor}” to search near. Name another place or area to search near.`
      : [
          `Which “${anchored.anchor}” should I search near?`,
          ...page.places.map(
            (place, index) => `${index + 1}. ${placeLabel(place)}`,
          ),
          `Tell me which one, such as “${anchored.kind} near ${(page.places[0] as PlaceRef).formattedAddress ?? (page.places[0] as PlaceRef).name}”.`,
        ].join("\n");
  return {
    success: false,
    text: reply,
    userFacingText: reply,
    verifiedUserFacing: true,
    data: {
      actionName: "MAPS",
      action: "place",
      reason: page.places.length === 0 ? "anchor_not_found" : "missing_input",
      awaitingUserInput: true,
    },
  };
}

/**
 * A destination that is a kind of place near the user (nearest pharmacy) is
 * not searched here: without a position the provider answers from anywhere.
 * The locate card hands the query to the device, which searches around its own
 * position and plans the route. The position stays on the device.
 */
function nearbyDestination(
  action: MapsSubaction,
  params: Params,
  query: string,
): ActionResult {
  const travelMode = namedTravelMode(params);
  return awaitingLocation(
    action,
    "route-origin",
    `I need your precise location to start the route to ${query}.`,
    { query, ...(travelMode ? { travelMode } : {}) },
    `If the phone can't get a location fix, tell me where you're starting from, or name a place to search near, such as “${placeKind(query)} near the Ferry Building”.`,
  );
}

/** True when the request asks for a typed destination near the user's position. */
function wantsNearbyDestination(params: Params): boolean {
  return (
    flag(params.useCurrentLocation) &&
    text(params.placeQuery) !== undefined &&
    opaqueText(params.savedPlaceId) === undefined &&
    opaqueText(params.placeId) === undefined &&
    params.latitude === undefined &&
    params.longitude === undefined
  );
}

/**
 * A place from ids or coordinates, else from the typed placeQuery. A choice
 * reply ("the first one") to this operation's open question answers it even
 * when the planner restates no query.
 */
async function requestedPlace(
  service: MapsService,
  action: MapsSubaction,
  params: Params,
  message: Memory,
  operation: PlaceChoiceOperation = action as PlaceChoiceOperation,
): Promise<PlaceRef | ActionResult | null> {
  const choice = openChoice(service, message, operation);
  const picked = choice && chosenPlace(choice, replyText(message));
  if (picked) {
    service.placeChoices.clear(message);
    return picked;
  }
  const place = await resolvedPlace(service, params, message.entityId);
  if (place) return place;
  const query = text(params.placeQuery);
  if (!query) return null;
  const found = await placeFromQuery(
    service,
    action,
    message,
    PLACE_QUERY_FIELD,
    query,
    { provider: text(params.provider) },
  );
  if (isReply(found)) {
    rememberChoice(service, message, operation, found, {
      queries: { placeQuery: query },
      resolved: {},
    });
  } else if (choice) {
    service.placeChoices.clear(message);
  }
  return found;
}

/** Distances read as km with one decimal from 1 km, metres to the nearest 10 below. */
function distanceText(meters: number): string {
  const rounded = Math.round(meters / 10) * 10;
  return rounded >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${rounded} m`;
}

/** Plain replies for failures whose provider message is not meant for the user. */
function userErrorText(error: MapsError, adapterCount: number): string {
  switch (error.code) {
    case "MAPS_PROVIDER_UNAVAILABLE":
      return adapterCount === 0 ? "Sign in to use Maps." : error.message;
    case "MAPS_ALLOWANCE_UNCONFIGURED":
      return "Maps isn't available for this account right now.";
    case "MAPS_ADMISSION_UNKNOWN":
      return "Maps couldn't confirm that request. Ask again if you still need it.";
    case "MAPS_REQUEST_CANCELLED":
      return "That Maps request was cancelled.";
    case "MAPS_BUDGET_EXHAUSTED":
      return "You've used your Maps requests for now.";
    case "MAPS_RATE_LIMITED":
      return "Maps is busy. Try again in a moment.";
    case "MAPS_AUTH_EXPIRED":
    case "MAPS_AUTH_REVOKED":
      return "Sign in again to use Maps.";
    case "MAPS_NOT_ENTITLED":
      return "Maps needs an active subscription.";
    case "MAPS_PROVIDER_TIMEOUT":
    case "MAPS_PROVIDER_NETWORK":
    case "MAPS_PROVIDER_FAILURE":
      return "Maps couldn't be reached. Try again.";
    default:
      return error.message;
  }
}

function actionError(error: MapsError, service: MapsService): ActionResult {
  const retryAfterMs = error.retryAfterMs;
  const retryable =
    error.code === "MAPS_RATE_LIMITED" ||
    error.code === "MAPS_PROVIDER_FAILURE" ||
    error.code === "MAPS_PROVIDER_TIMEOUT" ||
    error.code === "MAPS_PROVIDER_NETWORK";
  // A cancelled request is a settled outcome, not a failure to retry. Cloud may
  // report it before admission or after dispatch, so the planner must not replay it.
  const cancelled = error.code === "MAPS_REQUEST_CANCELLED";
  return {
    success: false,
    text: error.message,
    userFacingText: userErrorText(error, service.listAdapters().length),
    data: {
      actionName: "MAPS",
      error: error.code,
      ...(cancelled ? { reason: "cancelled", cancelled: true } : {}),
      retryable,
      ...(retryAfterMs !== undefined
        ? { retry: { retryable: true, retryAfterMs } }
        : {}),
    },
    error,
  };
}

/** Reports the device's own navigation state; the agent never claims more. */
function deviceResult(
  actionName: string,
  action: string,
  status: MapsDeviceNavigationStatus,
): ActionResult {
  if (
    !status ||
    ![
      "selected",
      "navigating",
      "stopped",
      "awaiting-location",
      "awaiting-confirmation",
    ].includes(status.state)
  ) {
    throw new MapsError("The phone returned an invalid navigation state.", {
      code: "MAPS_MALFORMED_RESPONSE",
    });
  }
  const place = status.placeName ?? "the destination";
  const userFacingText =
    status.state === "selected"
      ? `Selected ${place} on the map.`
      : status.state === "navigating"
        ? `Navigating to ${place}${status.travelMode ? ` by ${status.travelMode}` : ""}.`
        : status.state === "awaiting-confirmation"
          ? `Confirm on the phone to start navigation to ${place}.`
          : status.state === "awaiting-location"
            ? // No fix, no permission or a fix too coarse to start from: the route sheet is
              // open on the phone, and a starting place from the owner plans it instead.
              `The phone's location isn't available, so the route to ${place} isn't planned yet. Where are you starting from? You can also enter a starting point in Maps on the phone.`
            : "Navigation stopped.";
  const waitingReason =
    status.state === "awaiting-confirmation"
      ? "device_confirmation"
      : status.state === "awaiting-location"
        ? "device_location"
        : undefined;
  return {
    success: waitingReason === undefined,
    text: userFacingText,
    userFacingText,
    verifiedUserFacing: true,
    data: {
      actionName,
      action,
      device: status,
      ...(waitingReason
        ? { awaitingUserInput: true, reason: waitingReason }
        : {}),
    },
  };
}

/** The phone's navigation owner when it reports it can take a request now. */
async function availableDevice(
  service: MapsService,
): Promise<MapsDeviceNavigation | null> {
  try {
    const device = service.requireDeviceNavigation();
    return (await device.available?.()) === true ? device : null;
  } catch (error) {
    // A typed refusal from the owner or its probe means "use the link".
    if (error instanceof MapsError) return null;
    throw error;
  }
}

async function execute(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
  options?: HandlerOptions,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const params = parameters(message, options);
  const action = normalizeAction(params.action) ?? "place";
  if (
    action === "save" &&
    !(
      options as HandlerOptions & {
        [MAPS_SAVE_VIRTUAL_EXECUTION]?: boolean;
      }
    )?.[MAPS_SAVE_VIRTUAL_EXECUTION]
  ) {
    // A planner-only refusal: nothing is said to the user.
    return {
      success: false,
      text: "Saving places requires the receipt-enforced MAPS_SAVE action.",
      error: "MAPS_SAVE_REQUIRED",
      data: { actionName: "MAPS", action: "save" },
    };
  }
  const service = getMapsService(runtime);
  try {
    switch (action) {
      case "place": {
        const placeId = opaqueText(params.placeId);
        if (placeId) {
          const { place, provider } = await service.getPlaceResult(
            placeId,
            text(params.provider),
          );
          if (!place) {
            return result(
              action,
              {
                success: true,
                text: "No matching place was found.",
                userFacingText: "No matching place was found.",
                verifiedUserFacing: true,
                data: {
                  actionName: "MAPS",
                  action,
                  status: "empty",
                  place: null,
                },
              },
              callback,
            );
          }
          return result(
            action,
            {
              success: true,
              text: `Found ${place.name}.`,
              userFacingText: appendMapsCard(
                place.formattedAddress
                  ? `${place.name} — ${place.formattedAddress}`
                  : place.name,
                {
                  kind: "place",
                  place: toCardPlace(place),
                  attribution: provider.attribution,
                },
              ),
              verifiedUserFacing: true,
              data: { actionName: "MAPS", action, status: "found", place },
            },
            callback,
          );
        }
        const query = text(params.query);
        const pointLatitude = number(params.latitude);
        const pointLongitude = number(params.longitude);
        if (
          !query &&
          pointLatitude !== undefined &&
          pointLongitude !== undefined
        ) {
          // Coordinates without a query: the place at that point (reverse geocode).
          const { place, provider } = await service.reverseGeocodeResult(
            validated(
              coordinatesSchema,
              { latitude: pointLatitude, longitude: pointLongitude },
              "Coordinates are outside the valid latitude/longitude range.",
            ),
            text(params.provider),
          );
          if (!place) {
            return result(
              action,
              {
                success: true,
                text: "No named place is known at those coordinates.",
                userFacingText: "No named place is known at those coordinates.",
                verifiedUserFacing: true,
                data: {
                  actionName: "MAPS",
                  action,
                  status: "empty",
                  place: null,
                },
              },
              callback,
            );
          }
          return result(
            action,
            {
              success: true,
              text: `Found ${place.name}.`,
              userFacingText: appendMapsCard(
                place.formattedAddress
                  ? `${place.name} — ${place.formattedAddress}`
                  : place.name,
                {
                  kind: "place",
                  place: toCardPlace(place),
                  attribution: provider.attribution,
                },
              ),
              verifiedUserFacing: true,
              data: { actionName: "MAPS", action, status: "found", place },
            },
            callback,
          );
        }
        if (!query) {
          return result(
            action,
            missingInput(
              action,
              message,
              [
                {
                  name: "query",
                  type: "text",
                  label: "Place or address",
                  required: true,
                },
                {
                  name: "limit",
                  type: "number",
                  label: "Max results (1-100)",
                  required: false,
                },
              ],
              "What place or address should I look up?",
            ),
            callback,
          );
        }
        const latitude = number(params.latitude);
        const longitude = number(params.longitude);
        // "pharmacy near the Ferry Building" names its own search point, so
        // it needs no position from the phone. A planner may pass the whole
        // phrase as the query, or only the kind of place with
        // useCurrentLocation; the owner's own words decide.
        const anchored =
          latitude === undefined && longitude === undefined
            ? (anchoredPlaceQuery(query) ??
              (flag(params.useCurrentLocation)
                ? anchoredPlaceQuery(replyText(message) ?? "")
                : undefined))
            : undefined;
        if (
          !anchored &&
          flag(params.useCurrentLocation) &&
          latitude === undefined &&
          longitude === undefined
        ) {
          return result(
            action,
            awaitingLocation(
              action,
              "place-near",
              `I need your precise location to search near you for “${query}”.`,
              { query },
              `If the phone can't get a location fix, name a place or area to search near instead, such as “${placeKind(query)} near the Ferry Building”.`,
            ),
            callback,
          );
        }
        let anchor: PlaceRef | undefined;
        if (anchored) {
          const found = await searchAnchor(service, anchored, params);
          if (!("coordinates" in found)) return result(action, found, callback);
          anchor = found;
        }
        const searchQuery = anchored?.kind ?? query;
        const near = anchor
          ? anchor.coordinates
          : latitude !== undefined || longitude !== undefined
            ? validated(
                coordinatesSchema,
                { latitude, longitude },
                "Coordinates are outside the valid latitude/longitude range.",
              )
            : undefined;
        const { page, provider: searchProvider } =
          await service.searchPlacesResult(
            {
              query: searchQuery,
              near,
              // Ask the provider for the closest places, not the closest of
              // its most relevant ones.
              ...(near ? { rank: "distance" as const } : {}),
              cursor: opaqueText(params.cursor),
              limit: number(params.limit),
            },
            text(params.provider),
          );
        // With a search point the answer is "nearest": order by distance from
        // it and say how far each place is, so the reply can name the closest.
        const away = (place: PlaceRef) =>
          near ? metersBetween(near, place.coordinates) : 0;
        const places = near
          ? [...page.places].sort((a, b) => away(a) - away(b))
          : page.places;
        const empty = places.length === 0;
        const nearName = anchor ? ` near ${anchor.name}` : "";
        const none = anchor
          ? `I couldn't find “${searchQuery}” near ${anchor.name}.`
          : "No matching places were found.";
        return result(
          action,
          {
            success: true,
            text: empty
              ? none
              : [
                  `Found ${places.length} place${places.length === 1 ? "" : "s"}${nearName}${near ? ", nearest first" : ""}:`,
                  ...places.map(
                    (place) =>
                      `${place.name}${place.formattedAddress ? `, ${place.formattedAddress}` : ""}${near ? ` (${distanceText(away(place))} away)` : ""}`,
                  ),
                ].join("\n"),
            userFacingText: empty
              ? none
              : appendMapsCard(
                  [
                    ...(anchor ? [`Near ${anchor.name}:`] : []),
                    ...places.map(
                      (place) =>
                        `${place.name}${near ? `, ${distanceText(away(place))} away` : ""}`,
                    ),
                  ].join("\n"),
                  {
                    kind: "places",
                    query: searchQuery,
                    places: places
                      .slice(0, MAPS_CARD_MAX_PLACES)
                      .map(toCardPlace),
                    nextCursor: page.nextCursor,
                    attribution: searchProvider.attribution,
                  },
                ),
            verifiedUserFacing: true,
            data: {
              actionName: "MAPS",
              action,
              status: empty ? "empty" : "found",
              page: { ...page, places },
            },
          },
          callback,
        );
      }
      case "route": {
        const choice = openChoice(service, message, "route");
        const picked = choice && chosenPlace(choice, replyText(message));
        const pending = picked ? choice : undefined;
        const originPlaceId = opaqueText(params.originPlaceId);
        const destinationPlaceId = opaqueText(params.destinationPlaceId);
        let origin = pending
          ? ((pending.field === "originQuery"
              ? picked
              : pending.resolved.originQuery) ?? null)
          : (directPlace(params, "origin") ??
            (originPlaceId
              ? await service.getPlace(originPlaceId, text(params.provider))
              : null));
        let destination = pending
          ? ((pending.field === "destinationQuery"
              ? picked
              : pending.resolved.destinationQuery) ?? null)
          : (directPlace(params, "destination") ??
            (destinationPlaceId
              ? await service.getPlace(
                  destinationPlaceId,
                  text(params.provider),
                )
              : null));
        const originQuery = pending
          ? pending.queries.originQuery
          : text(params.originQuery);
        const destinationQuery = pending
          ? pending.queries.destinationQuery
          : text(params.destinationQuery);
        const requestedMode = pending
          ? pending.travelMode
          : text(params.travelMode);
        const travelModeName = requestedMode
          ? validated(
              travelModeSchema,
              requestedMode,
              "Travel mode must be drive, walk, bicycle, or transit.",
            )
          : undefined;
        // Endpoints are settled in order, origin first, so each question is
        // about one endpoint and the owner's answer binds to that one.
        const remember = (reply: ActionResult) =>
          rememberChoice(service, message, "route", reply, {
            queries: {
              ...(originQuery || origin
                ? { originQuery: originQuery ?? origin?.name }
                : {}),
              ...(destinationQuery ? { destinationQuery } : {}),
            },
            resolved: {
              ...(origin ? { originQuery: origin } : {}),
              ...(destination ? { destinationQuery: destination } : {}),
            },
            ...(travelModeName ? { travelMode: travelModeName } : {}),
          });
        if (!origin && originQuery) {
          const found = await placeFromQuery(
            service,
            action,
            message,
            ORIGIN_QUERY_FIELD,
            originQuery,
            {
              provider: text(params.provider),
              anchor: destination,
            },
          );
          if (isReply(found)) {
            remember(found);
            return result(action, found, callback);
          }
          origin = found;
        }
        if (!destination && destinationQuery) {
          const found = await placeFromQuery(
            service,
            action,
            message,
            DESTINATION_QUERY_FIELD,
            destinationQuery,
            {
              provider: text(params.provider),
              anchor: origin,
              ...(origin ? { note: `Starting from ${origin.name}.` } : {}),
            },
          );
          if (isReply(found)) {
            // Several matches for a route from here: the device's position
            // picks the one meant, so the device searches around itself.
            if (
              !origin &&
              flag(params.useCurrentLocation) &&
              found.data?.reason === "missing_input"
            )
              return result(
                action,
                nearbyDestination(action, params, destinationQuery),
                callback,
              );
            remember(found);
            return result(action, found, callback);
          }
          destination = found;
        }
        if (!origin && destination && flag(params.useCurrentLocation)) {
          const travelMode = travelModeName;
          return result(
            action,
            awaitingLocation(
              action,
              "route-origin",
              `I need your precise location to start the route to ${destination.name}.`,
              {
                destination: toCardPlace(destination),
                ...(travelMode ? { travelMode } : {}),
              },
            ),
            callback,
          );
        }
        if (!origin || !destination) {
          const unresolvedFields: FormInteraction["fields"] = [];
          if (!origin) unresolvedFields.push(ORIGIN_QUERY_FIELD);
          if (!destination) unresolvedFields.push(DESTINATION_QUERY_FIELD);
          unresolvedFields.push(
            travelModeField(
              await servedTravelModes(service, text(params.provider)),
            ),
          );
          return result(
            action,
            missingInput(
              action,
              message,
              unresolvedFields,
              !origin && !destination
                ? "I need both a starting place and a destination."
                : !origin
                  ? "I still need a starting place."
                  : "I still need a destination.",
            ),
            callback,
          );
        }
        // Both endpoints are settled: no question is open any more.
        if (choice) service.placeChoices.clear(message);
        const routeRequest = {
          origin,
          destination,
          travelMode: travelModeName ?? ("drive" as const),
        };
        await assertTransitServed(
          service,
          routeRequest.travelMode,
          text(params.provider),
        );
        const { routes, provider: routeProvider } = flag(params.alternatives)
          ? await service.planRouteAlternativesResult(
              routeRequest,
              text(params.provider),
            )
          : await service
              .planRouteResult(routeRequest, text(params.provider))
              .then(({ route, provider }) => ({ routes: [route], provider }));
        const [route] = routes as [RoutePlan, ...RoutePlan[]];
        const minutes = Math.round(route.durationSeconds / 60);
        const distance = distanceText(route.distanceMeters);
        const others = routes
          .slice(1)
          .map(
            (alternative, index) =>
              `Alternative ${index + 1}: about ${Math.round(alternative.durationSeconds / 60)} min, ${distanceText(alternative.distanceMeters)}.`,
          );
        return result(
          action,
          {
            success: true,
            text: [
              `${distance}, about ${minutes} min by ${route.travelMode}.`,
              ...others,
            ].join("\n"),
            userFacingText: appendMapsCard(
              [
                `${route.origin.name} to ${route.destination.name}: ${distance}, about ${minutes} min by ${route.travelMode}.`,
                ...others,
              ].join("\n"),
              routeCard(route, routeProvider.attribution),
            ),
            verifiedUserFacing: true,
            data: {
              actionName: "MAPS",
              action,
              route,
              ...(routes.length > 1 ? { alternatives: routes.slice(1) } : {}),
            },
          },
          callback,
        );
      }
      case "select": {
        const place = await requestedPlace(service, action, params, message);
        if (place && isReply(place)) return result(action, place, callback);
        if (!place) {
          return result(
            action,
            missingInput(
              action,
              message,
              [PLACE_QUERY_FIELD],
              "Which place should I select on the map?",
            ),
            callback,
          );
        }
        const status = await service.requireDeviceNavigation().select(place);
        return result(action, deviceResult("MAPS", action, status), callback);
      }
      case "save": {
        const place = await requestedPlace(service, action, params, message);
        if (place && isReply(place)) return result(action, place, callback);
        if (!place) {
          return result(
            action,
            missingInput(
              action,
              message,
              [
                PLACE_QUERY_FIELD,
                {
                  name: "label",
                  type: "text",
                  label: "Saved label",
                  required: false,
                },
              ],
              "Which place should I save?",
            ),
            callback,
          );
        }
        const saved = await service.savePlace({
          ownerEntityId: message.entityId,
          roomId: message.roomId,
          place,
          label: text(params.label),
          idempotencyKey: text(params.idempotencyKey),
        });
        if (saved.replayed && !saved.currentlyApplied) {
          const userFacingText = `${saved.savedPlace.label} was saved previously, but that state was superseded; the current saved label is ${saved.currentSavedPlace?.label ?? "no longer available"}.`;
          return result(
            action,
            {
              success: false,
              text: userFacingText,
              userFacingText,
              verifiedUserFacing: true,
              error: "MAPS_IDEMPOTENCY_SUPERSEDED",
              data: {
                actionName: "MAPS",
                action,
                replayed: true,
                commitId: saved.commitId,
                committedAt: saved.committedAt,
                savedPlace: saved.savedPlace,
                currentlyApplied: false,
                currentSavedPlace: saved.currentSavedPlace,
              },
            },
            callback,
          );
        }
        const observedAt = saved.replayed
          ? new Date(
              Math.max(Date.now(), Date.parse(saved.committedAt) + 1),
            ).toISOString()
          : saved.committedAt;
        const receiptId = saved.replayed
          ? `maps:save:${saved.commitId}:replay:${randomUUID()}`
          : `maps:save:${saved.commitId}`;
        const idempotencyKey = saved.idempotencyKey;
        const effect: EffectReceipt = saved.replayed
          ? {
              receiptId,
              operation: "maps.saved-place.save",
              resource: { kind: "maps.saved-place", id: saved.savedPlace.id },
              artifacts: [],
              idempotency: { key: idempotencyKey, replayed: true },
              observedAt,
              outcome: "noop",
              reason: saved.currentlyApplied
                ? "Reused the previously committed saved place."
                : "Replayed a historical save that a later mutation superseded.",
            }
          : {
              receiptId,
              operation: "maps.saved-place.save",
              resource: { kind: "maps.saved-place", id: saved.savedPlace.id },
              artifacts: [],
              idempotency: { key: idempotencyKey, replayed: false },
              observedAt,
              outcome: "applied",
              commit: {
                kind: "durable",
                id: saved.commitId,
                committedAt: saved.committedAt,
              },
            };
        const userFacingText = saved.replayed
          ? saved.currentlyApplied
            ? `${saved.savedPlace.label} was already saved.`
            : `${saved.savedPlace.label} was saved previously; the current saved label is ${saved.currentSavedPlace?.label ?? "no longer available"}.`
          : service.hasSavedPlacesHost()
            ? `Saved ${saved.savedPlace.label}.`
            : // MAPS_SAVE writes only the agent's store; without a device host the
              // phone's own Maps list does not get the place.
              `Saved ${saved.savedPlace.label} with your assistant. It isn't in the phone's Maps list.`;
        return result(
          action,
          {
            success: true,
            text: userFacingText,
            userFacingText,
            verifiedUserFacing: true,
            data: {
              actionName: "MAPS",
              action,
              savedPlace: saved.savedPlace,
              replayed: saved.replayed,
              commitId: saved.commitId,
              committedAt: saved.committedAt,
              currentlyApplied: saved.currentlyApplied,
              currentSavedPlace: saved.currentSavedPlace,
            },
            effectReceipts: [effect],
            userFacingEffectReceiptIds: [receiptId],
          },
          callback,
        );
      }
      case "saved": {
        // Read-only: the sender's saved places, reconciled with the phone's own
        // Maps list when the device host registered one. The device list is the
        // owner's, so only an owner-authorized sender reads it. Nothing is written.
        const listing = await service.listReconciledSavedPlaces(
          message.entityId,
          { includeDevice: await hasOwnerAccess(runtime, message) },
        );
        const names = listing.places.map((row) => row.label);
        // Without the phone's list the reply covers only the assistant's own
        // saves and says so.
        const deviceNote =
          listing.device === "unavailable"
            ? " Places saved only on the phone could not be read right now."
            : listing.device === "none"
              ? " Places saved only on the phone's Maps screen aren't included."
              : "";
        const prose = names.length
          ? `Saved places: ${names.join(", ")}.${deviceNote}`
          : listing.device === "none"
            ? `No places are saved with your assistant yet.${deviceNote}`
            : `You have no saved places.${deviceNote}`;
        return result(
          action,
          {
            success: true,
            text: prose,
            userFacingText: prose,
            verifiedUserFacing: true,
            data: {
              actionName: "MAPS",
              action,
              places: listing.places,
              device: listing.device,
              ...(listing.namespace ? { namespace: listing.namespace } : {}),
            },
          },
          callback,
        );
      }
      case "coverage": {
        // Read-only: what the provider reports it serves. Nothing is inferred
        // for a provider that publishes no coverage.
        const { coverage, provider } = await service.coverageResult(
          text(params.provider),
        );
        const summary = coverage
          ? describeMapsCoverage(coverage)
          : `The ${provider.id} maps provider does not report its coverage.`;
        const prose = provider.attribution
          ? `${summary} Data: ${provider.attribution}`
          : summary;
        return result(
          action,
          {
            success: true,
            text: prose,
            userFacingText: prose,
            verifiedUserFacing: true,
            data: {
              actionName: "MAPS",
              action,
              status: coverage ? "reported" : "unreported",
              coverage,
              provider,
            },
          },
          callback,
        );
      }
      case "share":
      case "navigate": {
        if (action === "navigate" && wantsNearbyDestination(params)) {
          return result(
            action,
            nearbyDestination(action, params, text(params.placeQuery) ?? ""),
            callback,
          );
        }
        const place = await requestedPlace(service, action, params, message);
        if (place && isReply(place)) return result(action, place, callback);
        if (!place) {
          return result(
            action,
            missingInput(
              action,
              message,
              [PLACE_QUERY_FIELD],
              action === "share"
                ? "Which place should I share?"
                : "Where should navigation go?",
            ),
            callback,
          );
        }
        if (action === "share") {
          const share = shareConfirmation(message, place);
          // Only the user's own later reply confirms; a model-supplied flag
          // or the asking message itself never does.
          const decision = await requireConfirmation({
            runtime,
            message,
            actionName: "MAPS_SHARE",
            pendingKey: `share:${place.provider}:${place.providerPlaceId}`,
            prompt: share.text ?? "",
          });
          if (decision.status === "pending") {
            return result(action, share, callback);
          }
          if (decision.status === "cancelled") {
            return result(
              action,
              {
                success: false,
                text: "Not shared.",
                userFacingText: "Not shared.",
                verifiedUserFacing: true,
                data: { actionName: "MAPS", action, reason: "cancelled" },
              },
              callback,
            );
          }
        } else {
          // The phone's own review still gates guidance; without a connected
          // phone the user gets a directions link.
          const device = await availableDevice(service);
          if (device) {
            const travelMode = validated(
              travelModeSchema,
              text(params.travelMode) ?? "drive",
              "Travel mode must be drive, walk, bicycle, or transit.",
            );
            return result(
              action,
              deviceResult(
                "MAPS",
                action,
                await device.start({ destination: place, travelMode }),
              ),
              callback,
            );
          }
        }
        const handoff =
          action === "share"
            ? service.createShareHandoff(place)
            : service.createNavigationHandoff(place);
        const sharedAt =
          action === "share" ? new Date().toISOString() : undefined;
        const prose =
          action === "share"
            ? `Shared ${place.name}: ${handoff.uri}`
            : `Open navigation to ${place.name}: ${handoff.uri}`;
        return result(
          action,
          {
            success: true,
            text: prose,
            userFacingText: appendMapsCard(
              prose,
              handoffCard(handoff, sharedAt),
            ),
            verifiedUserFacing: true,
            data: {
              actionName: "MAPS",
              action,
              handoff,
              ...(sharedAt ? { sharedAt } : {}),
            },
          },
          callback,
        );
      }
    }
  } catch (error) {
    // error-policy:J1 The action boundary translates typed domain/provider
    // failures for the planner; unexpected programming errors still throw.
    if (error instanceof MapsError)
      return result(action, actionError(error, service), callback);
    throw error;
  }
}

export const mapsAction: Action = {
  name: "MAPS",
  egress: ["owner-device", "public-network"],
  similes: [
    "MAP",
    "PLACES",
    "DIRECTIONS",
    "ROUTE",
    "SAVED_PLACES",
    "NAVIGATION",
  ],
  description:
    "Look up places, plan routes, save places, list saved places, create shareable geo links, hand a destination to navigation, or report which regions and travel modes Maps covers. Use the specific promoted MAPS_* action when the requested operation is known. Saving a place runs only through MAPS_SAVE.",
  descriptionCompressed:
    "Place search, routes, saved places, sharing, navigation, and coverage.",
  // "maps" is the registered Stage-1 context (plugin.ts); the others are
  // kept for callers that scope by them.
  contexts: ["maps", "location", "travel", "productivity"],
  routingHint:
    "Use MAPS_PLACE for place/address lookup and for what is nearby or nearest (set useCurrentLocation when the user says near me or nearest and gave no place), MAPS_SELECT to show a place on the phone map, MAPS_ROUTE for distance, travel time and directions between two named places, MAPS_NAVIGATION_START for directions from where the user is now (the phone plans from its own location; set useCurrentLocation when the destination is the nearest or a nearby kind of place), MAPS_SAVE to persist a place, MAPS_SAVED to list places saved with the assistant, MAPS_SHARE for a geo share link after the user confirms, MAPS_NAVIGATE to start phone navigation when the phone is connected and otherwise return a directions link, and MAPS_COVERAGE for the regions, travel modes and location recipients of the connected provider. Use MAPS_NAVIGATION_START, MAPS_NAVIGATION_REROUTE and MAPS_NAVIGATION_STOP for in-app phone navigation.",
  // Direct umbrella execution is read-only. The promoted MAPS_SAVE virtual
  // owns the write and receipt contract in plugin.ts.
  tags: ["domain:maps"],
  parameters: [
    {
      name: "action",
      description:
        "Maps operation: place | select | route | share | navigate | coverage | saved. MAPS rejects save; call MAPS_SAVE to save a place.",
      required: false,
      schema: { type: "string", enum: [...MAPS_SUBACTIONS] },
    },
    {
      name: "query",
      description: "Place name, category, or address.",
      required: false,
      schema: { type: "string" },
      subactions: ["place"],
    },
    {
      name: "placeId",
      description: "Provider place identifier.",
      required: false,
      schema: { type: "string" },
      subactions: ["place", "select", "save", "share", "navigate"],
    },
    {
      name: "savedPlaceId",
      description: "Saved-place UUID.",
      required: false,
      schema: { type: "string" },
      subactions: ["select", "share", "navigate"],
    },
    {
      name: "provider",
      description: "Registered maps adapter id; omit for the default.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "cursor",
      description: "Opaque provider pagination cursor.",
      required: false,
      schema: { type: "string" },
      subactions: ["place"],
    },
    {
      name: "limit",
      description: "Place result limit from 1 to 100.",
      required: false,
      schema: { type: "number" },
      subactions: ["place"],
    },
    {
      name: "latitude",
      description:
        "Place/near latitude from -90 to 90. With longitude and no query, place finds what is at that point.",
      required: false,
      schema: { type: "number" },
      subactions: ["place", "select", "save", "share", "navigate"],
    },
    {
      name: "longitude",
      description: "Place/near longitude from -180 to 180.",
      required: false,
      schema: { type: "number" },
      subactions: ["place", "select", "save", "share", "navigate"],
    },
    {
      name: "name",
      description: "Name for a coordinate-defined place.",
      required: false,
      schema: { type: "string" },
      subactions: ["select", "save", "share", "navigate"],
    },
    {
      name: "address",
      description: "Optional formatted address.",
      required: false,
      schema: { type: "string" },
      subactions: ["save", "share", "navigate"],
    },
    {
      name: "placeQuery",
      description:
        "Place name or address the user typed, when no place id or coordinates are known.",
      required: false,
      schema: { type: "string" },
      subactions: ["select", "save", "share", "navigate"],
    },
    {
      name: "originQuery",
      description: "Route origin name or address, when no id is known.",
      required: false,
      schema: { type: "string" },
      subactions: ["route"],
    },
    {
      name: "destinationQuery",
      description: "Route destination name or address, when no id is known.",
      required: false,
      schema: { type: "string" },
      subactions: ["route"],
    },
    {
      name: "originPlaceId",
      description: "Route origin provider place id.",
      required: false,
      schema: { type: "string" },
      subactions: ["route"],
    },
    {
      name: "destinationPlaceId",
      description: "Route destination provider place id.",
      required: false,
      schema: { type: "string" },
      subactions: ["route"],
    },
    {
      name: "originLatitude",
      description:
        "Route origin latitude. Requires originLongitude and originName.",
      required: false,
      schema: { type: "number" },
      subactions: ["route"],
    },
    {
      name: "originLongitude",
      description:
        "Route origin longitude. Requires originLatitude and originName.",
      required: false,
      schema: { type: "number" },
      subactions: ["route"],
    },
    {
      name: "originName",
      description:
        "Route origin coordinate label. Required with originLatitude and originLongitude.",
      required: false,
      schema: { type: "string" },
      subactions: ["route"],
    },
    {
      name: "destinationLatitude",
      description:
        "Route destination latitude. Requires destinationLongitude and destinationName.",
      required: false,
      schema: { type: "number" },
      subactions: ["route"],
    },
    {
      name: "destinationLongitude",
      description:
        "Route destination longitude. Requires destinationLatitude and destinationName.",
      required: false,
      schema: { type: "number" },
      subactions: ["route"],
    },
    {
      name: "destinationName",
      description:
        "Route destination coordinate label. Required with destinationLatitude and destinationLongitude.",
      required: false,
      schema: { type: "string" },
      subactions: ["route"],
    },
    {
      name: "travelMode",
      description:
        "How the user travels: walk (walking, on foot), bicycle (bike, cycling), transit (train, subway, bus, public transport) or drive (car; the default when the user names no way to travel). Transit only where MAPS coverage lists it.",
      required: false,
      schema: { type: "string", enum: ["drive", "walk", "bicycle", "transit"] },
      subactions: ["route", "navigate"],
    },
    {
      name: "alternatives",
      description:
        "True to ask the provider for alternative routes in addition to the recommended one.",
      required: false,
      schema: { type: "boolean" },
      subactions: ["route"],
    },
    {
      name: "useCurrentLocation",
      description:
        "True when the request means the user's current position and no coordinates were supplied: near me, nearest or nearby (place), from here (route), or a navigate destination that is the nearest or a nearby kind of place (nearest pharmacy) and not one named place or address. The assistant never receives the position: the chat surface asks the user's device to use it.",
      required: false,
      schema: { type: "boolean" },
      subactions: ["place", "route", "navigate"],
    },
    {
      name: "label",
      description: "Owner-facing label for a saved place.",
      required: false,
      schema: { type: "string" },
      subactions: ["save"],
    },
    {
      name: "idempotencyKey",
      description: "Stable retry key for a save operation.",
      required: false,
      schema: { type: "string" },
      subactions: ["save"],
    },
  ],
  validate: async (_runtime, _message, _state, options) => {
    const value = (options?.parameters as Record<string, unknown> | undefined)
      ?.action;
    return value === undefined || normalizeAction(value) !== null;
  },
  handler: execute,
};

/** Marks only the promoted save virtual's delegated execution as writable. */
export function bindPromotedMapsSaveHandler(action: Action): void {
  const promotedHandler = action.handler;
  action.handler = (runtime, message, state, options, callback, responses) => {
    const marked = {
      ...(options ?? {}),
      [MAPS_SAVE_VIRTUAL_EXECUTION]: true,
    } as HandlerOptions;
    return promotedHandler(
      runtime,
      message,
      state,
      marked,
      callback,
      responses,
    );
  };
}

const NAVIGATION_SUBACTIONS = ["start", "reroute", "stop"] as const;
type NavigationSubaction = (typeof NAVIGATION_SUBACTIONS)[number];

function navigationSubaction(value: unknown): NavigationSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return NAVIGATION_SUBACTIONS.includes(normalized as NavigationSubaction)
    ? (normalized as NavigationSubaction)
    : null;
}

/**
 * Asks the phone to start, reroute or stop in-app navigation. The phone owns
 * GPS, the active route and guidance; Cloud supplies route data to the phone.
 */
async function executeNavigation(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
  options?: HandlerOptions,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const params = parameters(message, options);
  const action = navigationSubaction(params.action) ?? "start";
  const reply = async (value: ActionResult) => {
    await callback?.({
      text: value.userFacingText ?? value.text,
      actions: [`MAPS_NAVIGATION_${action.toUpperCase()}`],
    });
    return value;
  };
  const service = getMapsService(runtime);
  try {
    if (action === "stop") {
      return reply(
        deviceResult(
          "MAPS_NAVIGATION",
          action,
          await service.requireDeviceNavigation().stop(),
        ),
      );
    }
    if (action === "reroute") {
      return reply(
        deviceResult(
          "MAPS_NAVIGATION",
          action,
          await service.requireDeviceNavigation().reroute(),
        ),
      );
    }
    const device = service.requireDeviceNavigation();
    if (wantsNearbyDestination(params)) {
      return reply(
        nearbyDestination("navigate", params, text(params.placeQuery) ?? ""),
      );
    }
    const destination = await requestedPlace(
      service,
      "navigate",
      params,
      message,
      "navigation-start",
    );
    if (destination && isReply(destination)) return reply(destination);
    if (!destination) {
      return reply(
        missingInput(
          "navigate",
          message,
          [
            PLACE_QUERY_FIELD,
            travelModeField(await servedTravelModes(service)),
          ],
          "Where should navigation go?",
        ),
      );
    }
    const travelMode = validated(
      travelModeSchema,
      text(params.travelMode) ?? "drive",
      "Travel mode must be drive, walk, bicycle, or transit.",
    );
    return reply(
      deviceResult(
        "MAPS_NAVIGATION",
        action,
        await device.start({ destination, travelMode }),
      ),
    );
  } catch (error) {
    // error-policy:J1 Typed provider and device failures reach the planner.
    if (error instanceof MapsError) return reply(actionError(error, service));
    throw error;
  }
}

export const mapsNavigationAction: Action = {
  name: "MAPS_NAVIGATION",
  similes: ["TURN_BY_TURN", "START_NAVIGATION", "STOP_NAVIGATION", "REROUTE"],
  description:
    "Directions from where the user is now: start, reroute or stop in-app navigation on the phone. The phone plans the route from its own location, shows it on the map and asks the user before guidance starts.",
  descriptionCompressed: "Phone navigation start, reroute and stop.",
  contexts: ["maps", "location", "travel"],
  tags: ["domain:maps", "capability:device"],
  parameters: [
    {
      name: "action",
      description: "Navigation operation: start | reroute | stop.",
      required: false,
      schema: { type: "string", enum: [...NAVIGATION_SUBACTIONS] },
    },
    {
      name: "placeId",
      description: "Destination provider place identifier.",
      required: false,
      schema: { type: "string" },
      subactions: ["start"],
    },
    {
      name: "savedPlaceId",
      description: "Destination saved-place UUID.",
      required: false,
      schema: { type: "string" },
      subactions: ["start"],
    },
    {
      name: "placeQuery",
      description:
        "Destination name or address the user typed, when no id or coordinates are known.",
      required: false,
      schema: { type: "string" },
      subactions: ["start"],
    },
    {
      name: "provider",
      description: "Registered maps adapter id; omit for the default.",
      required: false,
      schema: { type: "string" },
      subactions: ["start"],
    },
    {
      name: "latitude",
      description: "Destination latitude. Requires longitude and name.",
      required: false,
      schema: { type: "number" },
      subactions: ["start"],
    },
    {
      name: "longitude",
      description: "Destination longitude. Requires latitude and name.",
      required: false,
      schema: { type: "number" },
      subactions: ["start"],
    },
    {
      name: "name",
      description: "Destination name for a coordinate-defined place.",
      required: false,
      schema: { type: "string" },
      subactions: ["start"],
    },
    {
      name: "travelMode",
      description:
        "How the user travels: walk (walking, on foot), bicycle (bike, cycling), transit (train, subway, bus, public transport) or drive (car; the default when the user names no way to travel).",
      required: false,
      schema: { type: "string", enum: ["drive", "walk", "bicycle", "transit"] },
      subactions: ["start"],
    },
    {
      name: "useCurrentLocation",
      description:
        "True only when placeQuery is the nearest or a nearby kind of place (nearest pharmacy, a gas station near me) and not one named place or address. The phone then finds it around its own position; the assistant never receives the position.",
      required: false,
      schema: { type: "boolean" },
      subactions: ["start"],
    },
  ],
  validate: async (_runtime, _message, _state, options) => {
    const value = (options?.parameters as Record<string, unknown> | undefined)
      ?.action;
    return value === undefined || navigationSubaction(value) !== null;
  },
  handler: executeNavigation,
};
