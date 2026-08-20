/**
 * Server interaction broker for the routed /maps view. Every capability in
 * `capabilities.ts` dispatches here against the owning runtime's MapsService,
 * so the mounted view, the planner, and chat share one read path. All
 * capabilities are read-only by design: saved-place writes stay on the
 * promoted MAPS_SAVE action, which the runtime settles with effect receipts.
 *
 * Expected domain failures (invalid input, provider unavailable, auth expiry,
 * rate limiting, not found) become explicit `success: false` results the view
 * renders as a distinct error state; systemic failures propagate to the shared
 * route boundary.
 */

import {
  ElizaError,
  type IAgentRuntime,
  isElizaError,
  toElizaError,
} from "@elizaos/core";
import { getMapsService, type MapsService } from "./service.js";
import type {
  Coordinates,
  PlacePage,
  PlaceRef,
  SavedPlace,
  TravelMode,
} from "./types.js";
import { travelModeSchema } from "./types.js";
import {
  buildMapsViewSnapshot,
  type MapsViewSnapshot,
  type RouteAlternative,
} from "./view-state.js";

export interface MapsInteractResult {
  success: boolean;
  text: string;
  data?: unknown;
  error?: { code: string; message: string };
}

const EXPECTED_FAILURE_CODES = new Set([
  "MAPS_INVALID_INPUT",
  "MAPS_PROVIDER_UNAVAILABLE",
  "MAPS_NOT_FOUND",
  "MAPS_AUTH_EXPIRED",
  "MAPS_AUTH_REVOKED",
  "MAPS_RATE_LIMITED",
]);

const ROUTE_MODES: readonly TravelMode[] = travelModeSchema.options;

function paramsRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ElizaError("Capability params must be a JSON object.", {
      code: "MAPS_INVALID_INPUT",
      context: { field: "params" },
      severity: "ephemeral",
    });
  }
  return value as Record<string, unknown>;
}

function assertOnlyParams(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(params).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new ElizaError(
      `Capability params contain unsupported field "${unknownKey}".`,
      {
        code: "MAPS_INVALID_INPUT",
        context: { field: unknownKey },
        severity: "ephemeral",
      },
    );
  }
}

function requiredString(
  params: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = params[field];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new ElizaError(
      `Capability parameter "${field}" must be a nonblank string of at most ${maxLength} characters.`,
      {
        code: "MAPS_INVALID_INPUT",
        context: { field },
        severity: "ephemeral",
      },
    );
  }
  return value;
}

function optionalNear(
  params: Record<string, unknown>,
): Coordinates | undefined {
  const hasLatitude = Object.hasOwn(params, "latitude");
  const hasLongitude = Object.hasOwn(params, "longitude");
  if (!hasLatitude && !hasLongitude) return undefined;
  if (!hasLatitude || !hasLongitude) {
    throw new ElizaError(
      "search-places requires latitude and longitude together.",
      {
        code: "MAPS_INVALID_INPUT",
        context: { fields: ["latitude", "longitude"] },
        severity: "ephemeral",
      },
    );
  }
  const { latitude, longitude } = params;
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    throw new ElizaError("Coordinates must be numbers in decimal degrees.", {
      code: "MAPS_INVALID_INPUT",
      context: { fields: ["latitude", "longitude"] },
      severity: "ephemeral",
    });
  }
  return { latitude, longitude };
}

function summarizePlaces(page: PlacePage): string {
  if (page.places.length === 0) return "No places matched that search.";
  const names = page.places.slice(0, 5).map((place) => place.name);
  const more =
    page.places.length > names.length
      ? ` and ${page.places.length - names.length} more`
      : "";
  return `Found ${page.places.length} places: ${names.join(", ")}${more}.`;
}

async function resolvePlace(
  service: MapsService,
  placeId: string,
  field: string,
): Promise<PlaceRef> {
  const place = await service.getPlace(placeId);
  if (!place) {
    throw new ElizaError(`No place exists for ${field} "${placeId}".`, {
      code: "MAPS_NOT_FOUND",
      context: { field, placeId },
      severity: "ephemeral",
    });
  }
  return place;
}

async function planAlternatives(
  service: MapsService,
  origin: PlaceRef,
  destination: PlaceRef,
): Promise<RouteAlternative[]> {
  const alternatives: RouteAlternative[] = [];
  for (const travelMode of ROUTE_MODES) {
    try {
      const route = await service.planRoute({
        origin,
        destination,
        travelMode,
      });
      alternatives.push({ travelMode, status: "ok", route });
    } catch (error) {
      // error-policy:J4 an unsupported or failing travel mode renders as an
      // explicit per-mode error row; it never hides the modes that did resolve.
      const normalized = isElizaError(error)
        ? error
        : toElizaError(error, "MAPS_PROVIDER_FAILURE");
      alternatives.push({
        travelMode,
        status: "error",
        code: normalized.code,
        message: normalized.message,
      });
    }
  }
  return alternatives;
}

function summarizeAlternatives(alternatives: RouteAlternative[]): string {
  const resolved = alternatives.filter(
    (alternative) => alternative.status === "ok",
  );
  if (resolved.length === 0) return "No travel mode produced a route.";
  return `Planned ${resolved.length} route ${
    resolved.length === 1 ? "alternative" : "alternatives"
  }: ${resolved
    .map(
      (alternative) =>
        `${alternative.travelMode} ${(alternative.route.distanceMeters / 1000).toFixed(1)} km in ${Math.round(alternative.route.durationSeconds / 60)} min`,
    )
    .join("; ")}.`;
}

function summarizeSavedPlaces(places: SavedPlace[]): string {
  if (places.length === 0) return "No places are saved yet.";
  return `Saved places: ${places
    .slice(0, 8)
    .map((saved) => saved.label)
    .join(", ")}${places.length > 8 ? ` and ${places.length - 8} more` : ""}.`;
}

function summarizeSnapshot(snapshot: MapsViewSnapshot): string {
  const providerText = snapshot.providerAvailable
    ? `Providers: ${snapshot.providers.map((provider) => provider.id).join(", ")}.`
    : "No maps provider is connected.";
  const savedText =
    snapshot.savedPlaces.status === "ok"
      ? `${snapshot.savedPlaces.places.length} saved ${
          snapshot.savedPlaces.places.length === 1 ? "place" : "places"
        }.`
      : snapshot.savedPlaces.reason;
  return `${providerText} ${savedText}`;
}

async function dispatchCapability(
  runtime: IAgentRuntime,
  service: MapsService,
  capability: string,
  paramsValue?: Record<string, unknown>,
): Promise<MapsInteractResult> {
  const params = paramsRecord(paramsValue);
  if (capability === "get-maps-state") {
    assertOnlyParams(params, []);
    const snapshot = await buildMapsViewSnapshot(runtime, service);
    return { success: true, text: summarizeSnapshot(snapshot), data: snapshot };
  }
  if (capability === "search-places") {
    assertOnlyParams(params, [
      "query",
      "latitude",
      "longitude",
      "cursor",
      "limit",
    ]);
    const near = optionalNear(params);
    const cursor = Object.hasOwn(params, "cursor")
      ? requiredString(params, "cursor", 2_048)
      : undefined;
    const limit = params.limit;
    if (
      limit !== undefined &&
      (typeof limit !== "number" || !Number.isInteger(limit))
    ) {
      throw new ElizaError("search-places limit must be an integer.", {
        code: "MAPS_INVALID_INPUT",
        context: { field: "limit" },
        severity: "ephemeral",
      });
    }
    const page = await service.searchPlaces({
      query: requiredString(params, "query", 500),
      ...(near ? { near } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { success: true, text: summarizePlaces(page), data: page };
  }
  if (capability === "get-place") {
    assertOnlyParams(params, ["placeId"]);
    const place = await resolvePlace(
      service,
      requiredString(params, "placeId", 512),
      "placeId",
    );
    return {
      success: true,
      text: `${place.name}${place.formattedAddress ? ` — ${place.formattedAddress}` : ""}.`,
      data: { place },
    };
  }
  if (capability === "plan-route-alternatives") {
    assertOnlyParams(params, ["originPlaceId", "destinationPlaceId"]);
    const origin = await resolvePlace(
      service,
      requiredString(params, "originPlaceId", 512),
      "originPlaceId",
    );
    const destination = await resolvePlace(
      service,
      requiredString(params, "destinationPlaceId", 512),
      "destinationPlaceId",
    );
    const alternatives = await planAlternatives(service, origin, destination);
    if (!alternatives.some((alternative) => alternative.status === "ok")) {
      const firstFailure = alternatives.find(
        (alternative) => alternative.status === "error",
      );
      return {
        success: false,
        text: "No travel mode produced a route between those places.",
        data: { origin, destination, alternatives },
        error: {
          code: firstFailure?.code ?? "MAPS_PROVIDER_FAILURE",
          message: firstFailure?.message ?? "No travel mode produced a route.",
        },
      };
    }
    return {
      success: true,
      text: summarizeAlternatives(alternatives),
      data: { origin, destination, alternatives },
    };
  }
  if (capability === "get-saved-places") {
    assertOnlyParams(params, []);
    const snapshot = await buildMapsViewSnapshot(runtime, service);
    if (snapshot.savedPlaces.status === "unavailable") {
      return {
        success: false,
        text: snapshot.savedPlaces.reason,
        error: {
          code: "MAPS_PROVIDER_UNAVAILABLE",
          message: snapshot.savedPlaces.reason,
        },
      };
    }
    return {
      success: true,
      text: summarizeSavedPlaces(snapshot.savedPlaces.places),
      data: { places: snapshot.savedPlaces.places },
    };
  }
  throw new ElizaError(`Maps does not support capability "${capability}".`, {
    code: "MAPS_UNKNOWN_CAPABILITY",
    context: { capability },
    severity: "ephemeral",
  });
}

export async function serverInteract(
  capability: string,
  params?: Record<string, unknown>,
  context?: { runtime?: IAgentRuntime },
): Promise<MapsInteractResult> {
  try {
    if (!context?.runtime) {
      throw new ElizaError(
        "Maps interaction requires an owning runtime service.",
        { code: "MAPS_PROVIDER_UNAVAILABLE", severity: "ephemeral" },
      );
    }
    return await dispatchCapability(
      context.runtime,
      getMapsService(context.runtime),
      capability,
      params,
    );
  } catch (error) {
    // error-policy:J1 expected capability input and provider failures become
    // explicit false results; systemic failures reach the shared route boundary.
    const normalized = isElizaError(error)
      ? error
      : toElizaError(error, "MAPS_INTERACT_FAILED");
    if (!EXPECTED_FAILURE_CODES.has(normalized.code)) throw normalized;
    return {
      success: false,
      text: normalized.message,
      error: { code: normalized.code, message: normalized.message },
    };
  }
}
