/** Validates browser responses from the authenticated Maps view broker. */

import { fetchWithCsrf } from "@elizaos/ui/api/csrf-client";
import {
  type MapsPlacePageResult,
  type MapsPlaceResult,
  type MapsProviderDescription,
  type MapsRouteResult,
  mapsPlacePageResultSchema,
  mapsPlaceResultSchema,
  mapsRouteResultSchema,
  type PlaceRef,
  type TravelMode,
} from "../types.js";

export type { MapsProviderDescription } from "../types.js";

interface BrokerEnvelope {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: unknown;
}

export interface MapsViewTransport {
  search(
    query: string,
    signal?: AbortSignal,
    cursor?: string,
    provider?: MapsProviderDescription,
  ): Promise<MapsPlacePageResult>;
  getPlace(
    place: PlaceRef,
    provider: MapsProviderDescription,
    signal?: AbortSignal,
  ): Promise<MapsPlaceResult>;
  planRoute(
    origin: PlaceRef,
    destination: PlaceRef,
    travelMode: TravelMode,
    provider: MapsProviderDescription,
    signal?: AbortSignal,
  ): Promise<MapsRouteResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    // error-policy:J2 malformed authenticated responses keep their parser cause.
    throw new Error("Maps returned malformed JSON.", { cause });
  }
}

async function invoke(
  capability: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchWithCsrf("/api/views/maps/interact", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ capability, params }),
    signal,
  });
  const value = await readJson(response);
  if (!response.ok) {
    throw new Error(
      isRecord(value)
        ? errorMessage(value.error, `Maps request failed (${response.status}).`)
        : `Maps request failed (${response.status}).`,
    );
  }
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    typeof value.success !== "boolean"
  ) {
    throw new Error("Maps returned an invalid broker envelope.");
  }
  const envelope = value as unknown as BrokerEnvelope;
  if (!envelope.success) {
    throw new Error(errorMessage(envelope.error, "Maps request failed."));
  }
  if (!isRecord(envelope.result) || envelope.result.success !== true) {
    throw new Error(
      isRecord(envelope.result)
        ? errorMessage(envelope.result.error, "Maps request failed.")
        : "Maps returned an invalid result.",
    );
  }
  return envelope.result.data;
}

export const mapsViewTransport: MapsViewTransport = {
  async search(query, signal, cursor, provider) {
    return mapsPlacePageResultSchema.parse(
      await invoke(
        "maps-search-places",
        {
          query,
          limit: 24,
          ...(cursor ? { cursor } : {}),
          ...(provider
            ? {
                provider: provider.id,
                providerGeneration: provider.generation,
              }
            : {}),
        },
        signal,
      ),
    );
  },
  async getPlace(place, provider, signal) {
    return mapsPlaceResultSchema.parse(
      await invoke(
        "maps-get-place",
        {
          placeId: place.providerPlaceId,
          provider: provider.id,
          providerGeneration: provider.generation,
        },
        signal,
      ),
    );
  },
  async planRoute(origin, destination, travelMode, provider, signal) {
    return mapsRouteResultSchema.parse(
      await invoke(
        "maps-plan-route",
        {
          origin,
          destination,
          travelMode,
          provider: provider.id,
          providerGeneration: provider.generation,
        },
        signal,
      ),
    );
  },
};
