/**
 * Browser-side transport and validation for the routed /maps view. The server
 * owns provider registration, search, routing, and saved places; this module
 * accepts only the authenticated route envelopes and the zod contracts shared
 * with the plugin before exposing anything to React.
 */

import { fetchWithCsrf } from "@elizaos/ui/api/csrf-client";
import * as z from "zod";
import { MAPS_VIEW_CAPABILITIES } from "../capabilities.js";
import {
  type PlacePage,
  type PlaceRef,
  placePageSchema,
  placeRefSchema,
} from "../types.js";
import {
  type MapsViewSnapshot,
  mapsViewSnapshotSchema,
  type RouteAlternative,
  routeAlternativeSchema,
} from "../view-contract.js";

export const MAPS_STATE_UPDATED_EVENT = "maps:state-updated";
export const MAPS_UPDATED_EVENT = "view:maps:updated";

const MAPS_CAPABILITY_IDS = new Set(MAPS_VIEW_CAPABILITIES.map(({ id }) => id));

const routeAlternativesDataSchema = z
  .object({
    origin: placeRefSchema,
    destination: placeRefSchema,
    alternatives: z.array(routeAlternativeSchema).min(1).max(8),
  })
  .strict();

export type RouteAlternativesData = z.infer<typeof routeAlternativesDataSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseErrorEnvelope(value: unknown, status: number): Error {
  if (isRecord(value) && typeof value.error === "string") {
    return new Error(value.error);
  }
  if (
    isRecord(value) &&
    value.success === false &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  ) {
    return new Error(value.error.message, { cause: value.error.code });
  }
  return new Error(`Maps request failed with HTTP ${status}.`);
}

function parseBrokerFailure(value: Record<string, unknown>): Error {
  if (typeof value.error === "string" && value.error.trim()) {
    return new Error(value.error);
  }
  if (
    isRecord(value.result) &&
    value.result.success === false &&
    typeof value.result.text === "string" &&
    value.result.text.trim()
  ) {
    const code = isRecord(value.result.error)
      ? value.result.error.code
      : undefined;
    return new Error(value.result.text, {
      ...(typeof code === "string" ? { cause: code } : {}),
    });
  }
  return new Error("Maps returned an invalid broker failure result.");
}

function parseBrokerData(value: unknown): unknown {
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    value.requestId.trim().length === 0 ||
    typeof value.success !== "boolean"
  ) {
    throw new Error("Maps returned an invalid broker envelope.");
  }
  if (!value.success) {
    throw parseBrokerFailure(value);
  }
  if (!isRecord(value.result) || value.result.success !== true) {
    throw parseBrokerFailure(value);
  }
  return value.result.data;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    // error-policy:J2 retain the parser cause at the authenticated API boundary.
    throw new Error("Maps returned malformed JSON.", { cause });
  }
}

function validated<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Maps returned an invalid ${what}.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function fetchMapsState(): Promise<MapsViewSnapshot> {
  const response = await fetchWithCsrf("/api/maps/state", {
    headers: { Accept: "application/json" },
  });
  const value = await readJson(response);
  if (!response.ok) {
    throw parseErrorEnvelope(value, response.status);
  }
  if (!isRecord(value) || value.success !== true || !("data" in value)) {
    throw new Error("Maps returned an invalid success envelope.");
  }
  return validated(mapsViewSnapshotSchema, value.data, "state snapshot");
}

async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (!MAPS_CAPABILITY_IDS.has(capability)) {
    throw new Error(`Maps does not support capability "${capability}".`);
  }
  const response = await fetchWithCsrf("/api/views/maps/interact", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ capability, ...(params ? { params } : {}) }),
  });
  const value = await readJson(response);
  if (!response.ok) {
    throw parseErrorEnvelope(value, response.status);
  }
  return parseBrokerData(value);
}

export async function searchPlaces(params: {
  query: string;
  latitude?: number;
  longitude?: number;
  cursor?: string;
  limit?: number;
}): Promise<PlacePage> {
  return validated(
    placePageSchema,
    await interact("search-places", params),
    "place page",
  );
}

export async function getPlace(placeId: string): Promise<PlaceRef> {
  const data = await interact("get-place", { placeId });
  if (!isRecord(data)) throw new Error("Maps returned an invalid place.");
  return validated(placeRefSchema, data.place, "place");
}

export async function planRouteAlternatives(params: {
  originPlaceId: string;
  destinationPlaceId: string;
}): Promise<RouteAlternativesData> {
  return validated(
    routeAlternativesDataSchema,
    await interact("plan-route-alternatives", params),
    "route alternatives result",
  );
}

export type { MapsViewSnapshot, PlacePage, PlaceRef, RouteAlternative };
