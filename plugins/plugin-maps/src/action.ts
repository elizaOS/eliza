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
import { appendInteractionBlock } from "@elizaos/core";
import {
  appendMapsCard,
  handoffCard,
  MAPS_CARD_MAX_PLACES,
  type MapsLocateCard,
  routeCard,
  toCardPlace,
} from "./card.js";
import { MapsError } from "./errors.js";
import { getMapsService, type MapsService } from "./service.js";
import {
  coordinatesSchema,
  type PlaceRef,
  placeRefSchema,
  travelModeSchema,
} from "./types.js";

const MAPS_SUBACTIONS = [
  "place",
  "route",
  "save",
  "share",
  "navigate",
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
 * Sharing a location is gated on an explicit in-chat confirmation so a model
 * turn can never disclose coordinates without the user's visible consent.
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

const TRAVEL_MODE_FIELD = {
  name: "travelMode",
  type: "select",
  label: "Travel mode",
  required: false,
  options: [
    { value: "drive", label: "Drive" },
    { value: "walk", label: "Walk" },
    { value: "bicycle", label: "Bicycle" },
    { value: "transit", label: "Transit" },
  ],
} as const satisfies FormInteraction["fields"][number];

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
      "Coordinate-defined places require latitude, longitude, and name together.",
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

function actionError(error: MapsError): ActionResult {
  const retryAfterMs = error.retryAfterMs;
  const retryable =
    error.code === "MAPS_RATE_LIMITED" ||
    error.code === "MAPS_PROVIDER_FAILURE" ||
    error.code === "MAPS_PROVIDER_TIMEOUT" ||
    error.code === "MAPS_PROVIDER_NETWORK";
  return {
    success: false,
    text: error.message,
    userFacingText: error.message,
    data: {
      actionName: "MAPS",
      error: error.code,
      retryable,
      ...(retryAfterMs !== undefined
        ? { retry: { retryable: true, retryAfterMs } }
        : {}),
    },
    error,
  };
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
    return result(
      action,
      {
        success: false,
        text: "Saving places requires the receipt-enforced MAPS_SAVE action.",
        userFacingText:
          "Saving places requires the receipt-enforced MAPS_SAVE action.",
        error: "MAPS_SAVE_REQUIRED",
        data: { actionName: "MAPS", action: "save" },
      },
      callback,
    );
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
        const origin =
          directPlace(params, "origin") ??
          (originPlaceId
            ? await service.getPlace(originPlaceId, text(params.provider))
            : null);
        const destination =
          directPlace(params, "destination") ??
          (destinationPlaceId
            ? await service.getPlace(destinationPlaceId, text(params.provider))
            : null);
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
          if (!origin) {
            unresolvedFields.push({
              name: "originPlaceId",
              type: "text",
              label: "Starting place ID",
              required: true,
            });
          }
          if (!destination) {
            unresolvedFields.push({
              name: "destinationPlaceId",
              type: "text",
              label: "Destination place ID",
              required: true,
            });
          }
          unresolvedFields.push(TRAVEL_MODE_FIELD);
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
        const { route, provider: routeProvider } =
          await service.planRouteResult(
            {
              origin,
              destination,
              travelMode: validated(
                travelModeSchema,
                text(params.travelMode) ?? "drive",
                "Travel mode must be drive, walk, bicycle, or transit.",
              ),
            },
            text(params.provider),
          );
        const minutes = Math.round(route.durationSeconds / 60);
        return result(
          action,
          {
            success: true,
            text: `${route.distanceMeters} m, about ${minutes} min by ${route.travelMode}.`,
            userFacingText: appendMapsCard(
              `${route.origin.name} to ${route.destination.name}: about ${minutes} min by ${route.travelMode}.`,
              routeCard(route, routeProvider.attribution),
            ),
            verifiedUserFacing: true,
            data: { actionName: "MAPS", action, route },
          },
          callback,
        );
      }
      case "save": {
        const place = await resolvedPlace(service, params, message.entityId);
        if (!place) {
          return result(
            action,
            missingInput(
              action,
              message,
              [
                {
                  name: "placeId",
                  type: "text",
                  label: "Place ID",
                  required: true,
                },
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
          : `Saved ${saved.savedPlace.label}.`;
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
      case "share":
      case "navigate": {
        const place = await resolvedPlace(service, params, message.entityId);
        if (!place) {
          return result(
            action,
            missingInput(
              action,
              message,
              [
                {
                  name: "savedPlaceId",
                  type: "text",
                  label: "Saved place ID",
                  required: true,
                },
              ],
              action === "share"
                ? "Which place should I share?"
                : "Where should navigation go?",
            ),
            callback,
          );
        }
        if (action === "share" && !flag(params.confirm)) {
          return result(action, shareConfirmation(message, place), callback);
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
      return result(action, actionError(error), callback);
    throw error;
  }
}

export const mapsAction: Action = {
  name: "MAPS",
  similes: [
    "MAP",
    "PLACES",
    "DIRECTIONS",
    "ROUTE",
    "SAVED_PLACES",
    "NAVIGATION",
  ],
  description:
    "Look up places, plan routes, save places, create shareable geo links, or hand a destination to navigation. Use the specific promoted MAPS_* action when the requested operation is known.",
  descriptionCompressed:
    "Place search, routes, saved places, sharing, and navigation.",
  contexts: ["location", "travel", "productivity"],
  routingHint:
    "Use MAPS_PLACE for place/address lookup, MAPS_ROUTE for directions, MAPS_SAVE to persist a place, MAPS_SHARE for a geo share link, and MAPS_NAVIGATE for a navigation handoff.",
  // Direct umbrella execution is read-only. The promoted MAPS_SAVE virtual
  // owns the write and receipt contract in plugin.ts.
  tags: ["domain:maps"],
  parameters: [
    {
      name: "action",
      description: "Maps operation.",
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
      subactions: ["place", "save", "share", "navigate"],
    },
    {
      name: "savedPlaceId",
      description: "Saved-place UUID.",
      required: false,
      schema: { type: "string" },
      subactions: ["share", "navigate"],
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
      description: "Place/near latitude from -90 to 90.",
      required: false,
      schema: { type: "number" },
      subactions: ["place", "save", "share", "navigate"],
    },
    {
      name: "longitude",
      description: "Place/near longitude from -180 to 180.",
      required: false,
      schema: { type: "number" },
      subactions: ["place", "save", "share", "navigate"],
    },
    {
      name: "name",
      description: "Name for a coordinate-defined place.",
      required: false,
      schema: { type: "string" },
      subactions: ["save", "share", "navigate"],
    },
    {
      name: "address",
      description: "Optional formatted address.",
      required: false,
      schema: { type: "string" },
      subactions: ["save", "share", "navigate"],
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
      description: "Route origin latitude.",
      required: false,
      schema: { type: "number" },
      subactions: ["route"],
    },
    {
      name: "originLongitude",
      description: "Route origin longitude.",
      required: false,
      schema: { type: "number" },
      subactions: ["route"],
    },
    {
      name: "originName",
      description: "Route origin coordinate label.",
      required: false,
      schema: { type: "string" },
      subactions: ["route"],
    },
    {
      name: "destinationLatitude",
      description: "Route destination latitude.",
      required: false,
      schema: { type: "number" },
      subactions: ["route"],
    },
    {
      name: "destinationLongitude",
      description: "Route destination longitude.",
      required: false,
      schema: { type: "number" },
      subactions: ["route"],
    },
    {
      name: "destinationName",
      description: "Route destination coordinate label.",
      required: false,
      schema: { type: "string" },
      subactions: ["route"],
    },
    {
      name: "travelMode",
      description: "drive | walk | bicycle | transit.",
      required: false,
      schema: { type: "string", enum: ["drive", "walk", "bicycle", "transit"] },
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
      name: "confirm",
      description:
        "Required true to emit a share link; without it the user is asked to confirm sharing their location.",
      required: false,
      schema: { type: "boolean" },
      subactions: ["share"],
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
