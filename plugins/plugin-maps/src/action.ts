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
): ActionResult {
  const userFacingText = appendMapsCard(prompt, {
    kind: "locate",
    intent,
    prompt,
  });
  return {
    success: false,
    text: prompt,
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

/**
 * Resolves a typed name or address to one place. Several matches ask which one
 * was meant; no match is the plain not-found reply.
 */
async function placeFromQuery(
  service: MapsService,
  action: MapsSubaction,
  message: Memory,
  field: FormInteraction["fields"][number],
  query: string,
  provider?: string,
): Promise<PlaceRef | ActionResult> {
  const { page, provider: searchProvider } = await service.searchPlacesResult(
    { query, limit: 5 },
    provider,
  );
  const [only] = page.places;
  if (only && page.places.length === 1) return only;
  if (!only) {
    return {
      success: false,
      text: "No matching place was found.",
      userFacingText: "No matching place was found.",
      verifiedUserFacing: true,
      data: { actionName: "MAPS", action, reason: "not_found", query },
    };
  }
  const ask = missingInput(
    action,
    message,
    [field],
    [
      "Which one did you mean?",
      ...page.places.map((place) =>
        place.formattedAddress
          ? `${place.name} — ${place.formattedAddress}`
          : place.name,
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
    data: { ...ask.data, places: page.places },
  };
}

/** A place from ids or coordinates, else from the typed placeQuery. */
async function requestedPlace(
  service: MapsService,
  action: MapsSubaction,
  params: Params,
  message: Memory,
): Promise<PlaceRef | ActionResult | null> {
  const place = await resolvedPlace(service, params, message.entityId);
  if (place) return place;
  const query = text(params.placeQuery);
  return query
    ? placeFromQuery(
        service,
        action,
        message,
        PLACE_QUERY_FIELD,
        query,
        text(params.provider),
      )
    : null;
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
            ? "The phone needs location access before navigation can start."
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
        if (
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
            ),
            callback,
          );
        }
        const near =
          latitude !== undefined || longitude !== undefined
            ? validated(
                coordinatesSchema,
                { latitude, longitude },
                "Coordinates are outside the valid latitude/longitude range.",
              )
            : undefined;
        const { page, provider: searchProvider } =
          await service.searchPlacesResult(
            {
              query,
              near,
              cursor: opaqueText(params.cursor),
              limit: number(params.limit),
            },
            text(params.provider),
          );
        const empty = page.places.length === 0;
        return result(
          action,
          {
            success: true,
            text: empty
              ? "No matching places were found."
              : `Found ${page.places.length} place${page.places.length === 1 ? "" : "s"}.`,
            userFacingText: empty
              ? "No matching places were found."
              : appendMapsCard(
                  page.places.map((place) => place.name).join("\n"),
                  {
                    kind: "places",
                    query,
                    places: page.places
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
              page,
            },
          },
          callback,
        );
      }
      case "route": {
        const originPlaceId = opaqueText(params.originPlaceId);
        const destinationPlaceId = opaqueText(params.destinationPlaceId);
        let origin =
          directPlace(params, "origin") ??
          (originPlaceId
            ? await service.getPlace(originPlaceId, text(params.provider))
            : null);
        let destination =
          directPlace(params, "destination") ??
          (destinationPlaceId
            ? await service.getPlace(destinationPlaceId, text(params.provider))
            : null);
        const originQuery = text(params.originQuery);
        if (!origin && originQuery) {
          const found = await placeFromQuery(
            service,
            action,
            message,
            ORIGIN_QUERY_FIELD,
            originQuery,
            text(params.provider),
          );
          if (isReply(found)) return result(action, found, callback);
          origin = found;
        }
        const destinationQuery = text(params.destinationQuery);
        if (!destination && destinationQuery) {
          const found = await placeFromQuery(
            service,
            action,
            message,
            DESTINATION_QUERY_FIELD,
            destinationQuery,
            text(params.provider),
          );
          if (isReply(found)) return result(action, found, callback);
          destination = found;
        }
        if (!origin && destination && flag(params.useCurrentLocation)) {
          return result(
            action,
            awaitingLocation(
              action,
              "route-origin",
              `I need your precise location to start the route to ${destination.name}.`,
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
        const routeRequest = {
          origin,
          destination,
          travelMode: validated(
            travelModeSchema,
            text(params.travelMode) ?? "drive",
            "Travel mode must be drive, walk, bicycle, or transit.",
          ),
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
  contexts: ["location", "travel", "productivity"],
  routingHint:
    "Use MAPS_PLACE for place/address lookup, MAPS_SELECT to show a place on the phone map, MAPS_ROUTE for directions, MAPS_SAVE to persist a place, MAPS_SAVED to list places saved with the assistant, MAPS_SHARE for a geo share link after the user confirms, MAPS_NAVIGATE to start phone navigation when the phone is connected and otherwise return a directions link, and MAPS_COVERAGE for the regions, travel modes and location recipients of the connected provider. Use MAPS_NAVIGATION_START, MAPS_NAVIGATION_REROUTE and MAPS_NAVIGATION_STOP for in-app phone navigation.",
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
        "drive | walk | bicycle | transit. Transit only where MAPS coverage lists it.",
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
        "True when the request references the user's current position and no coordinates were supplied; the chat surface then collects a precise device location.",
      required: false,
      schema: { type: "boolean" },
      subactions: ["place", "route"],
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
    const destination = await requestedPlace(
      service,
      "navigate",
      params,
      message,
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
    "Start, reroute or stop in-app navigation on the phone. The phone uses its own location and asks the user before guidance starts.",
  descriptionCompressed: "Phone navigation start, reroute and stop.",
  contexts: ["location", "travel"],
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
      description: "drive | walk | bicycle | transit.",
      required: false,
      schema: { type: "string", enum: ["drive", "walk", "bicycle", "transit"] },
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
