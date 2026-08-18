/** Implements the MAPS umbrella and its promoted place, route, save, share, and navigation actions. */

import type {
  Action,
  ActionResult,
  EffectReceipt,
  FormInteraction,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { appendInteractionBlock } from "@elizaos/core";
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
      missingFields: fields.map((field) => field.name),
      uiRequest: form,
    },
  };
}

function directPlace(params: Params, prefix = ""): PlaceRef | null {
  const field = (name: string) =>
    `${prefix}${prefix ? name[0]?.toUpperCase() : name[0]}${name.slice(1)}`;
  const latitude = number(params[field("latitude")]);
  const longitude = number(params[field("longitude")]);
  const name = text(params[field("name")]);
  if (latitude === undefined || longitude === undefined || !name) return null;
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
      provider: text(params.provider) ?? "coordinates",
      providerPlaceId:
        text(params[field("placeId")]) ??
        `coordinates:${latitude},${longitude}`,
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
  const savedPlaceId = text(params.savedPlaceId);
  if (savedPlaceId) {
    return (
      (await service.getSavedPlace(ownerEntityId, savedPlaceId))?.place ?? null
    );
  }
  const placeId = text(params.placeId);
  if (placeId) return service.getPlace(placeId, text(params.provider));
  return directPlace(params);
}

function actionError(error: MapsError): ActionResult {
  const retryAfterMs = error.retryAfterMs;
  return {
    success: false,
    text: error.message,
    userFacingText: error.message,
    data: {
      actionName: "MAPS",
      error: error.code,
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
  const service = getMapsService(runtime);
  try {
    switch (action) {
      case "place": {
        const placeId = text(params.placeId);
        if (placeId) {
          const place = await service.getPlace(placeId, text(params.provider));
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
              userFacingText: place.formattedAddress
                ? `${place.name} — ${place.formattedAddress}`
                : place.name,
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
              ],
              "What place or address should I look up?",
            ),
            callback,
          );
        }
        const latitude = number(params.latitude);
        const longitude = number(params.longitude);
        const near =
          latitude !== undefined || longitude !== undefined
            ? validated(
                coordinatesSchema,
                { latitude, longitude },
                "Coordinates are outside the valid latitude/longitude range.",
              )
            : undefined;
        const page = await service.searchPlaces(
          {
            query,
            near,
            cursor: text(params.cursor),
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
              : page.places.map((place) => place.name).join("\n"),
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
        const originPlaceId = text(params.originPlaceId);
        const destinationPlaceId = text(params.destinationPlaceId);
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
        if (!origin || !destination) {
          return result(
            action,
            missingInput(
              action,
              message,
              [
                {
                  name: "originPlaceId",
                  type: "text",
                  label: "Starting place ID",
                  required: true,
                },
                {
                  name: "destinationPlaceId",
                  type: "text",
                  label: "Destination place ID",
                  required: true,
                },
                {
                  name: "travelMode",
                  type: "select",
                  label: "Travel mode",
                  required: true,
                  options: [
                    { value: "drive", label: "Drive" },
                    { value: "walk", label: "Walk" },
                    { value: "bicycle", label: "Bicycle" },
                    { value: "transit", label: "Transit" },
                  ],
                },
              ],
              "I need both a starting place and a destination.",
            ),
            callback,
          );
        }
        const route = await service.planRoute(
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
            userFacingText: `${route.origin.name} to ${route.destination.name}: about ${minutes} min by ${route.travelMode}.`,
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
        const observedAt = saved.savedPlace.updatedAt;
        const receiptId = `maps:save:${saved.commitId}`;
        const idempotencyKey =
          saved.savedPlace.idempotencyKey ?? `maps-save:${saved.savedPlace.id}`;
        const effect: EffectReceipt = saved.replayed
          ? {
              receiptId,
              operation: "maps.saved-place.save",
              resource: { kind: "maps.saved-place", id: saved.savedPlace.id },
              artifacts: [],
              idempotency: { key: idempotencyKey, replayed: true },
              observedAt,
              outcome: "noop",
              reason: "Reused the previously committed saved place.",
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
                committedAt: observedAt,
              },
            };
        const userFacingText = saved.replayed
          ? `${saved.savedPlace.label} was already saved.`
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
        const handoff =
          action === "share"
            ? service.createShareHandoff(place)
            : service.createNavigationHandoff(place);
        const userFacingText =
          action === "share"
            ? `Share ${place.name}: ${handoff.uri}`
            : `Open navigation to ${place.name}: ${handoff.uri}`;
        return result(
          action,
          {
            success: true,
            text: userFacingText,
            userFacingText,
            verifiedUserFacing: true,
            data: { actionName: "MAPS", action, handoff },
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
  tags: [
    "domain:maps",
    "capability:read",
    "capability:write",
    "effect:idempotent",
  ],
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
