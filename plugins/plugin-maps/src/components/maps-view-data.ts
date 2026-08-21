/** Validates browser responses from the authenticated Maps view broker. */

import { fetchWithCsrf } from "@elizaos/ui/api/csrf-client";
import { z } from "zod";
import {
  type PlacePage,
  type PlaceRef,
  placePageSchema,
  placeRefSchema,
  type RoutePlan,
  routePlanSchema,
  type TravelMode,
} from "../types.js";

const mapsProviderDescriptionSchema = z
  .object({
    id: z.string().min(1).max(64),
    attribution: z.string().min(1).max(500).nullable(),
  })
  .strict();

export type MapsProviderDescription = z.infer<
  typeof mapsProviderDescriptionSchema
>;

interface BrokerEnvelope {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: unknown;
}

export interface MapsViewTransport {
  /** Optional for host/test transports; absence renders attribution unavailable. */
  describeProviders?(signal?: AbortSignal): Promise<MapsProviderDescription[]>;
  search(
    query: string,
    signal?: AbortSignal,
    cursor?: string,
  ): Promise<PlacePage>;
  getPlace(place: PlaceRef, signal?: AbortSignal): Promise<PlaceRef | null>;
  planRoute(
    origin: PlaceRef,
    destination: PlaceRef,
    travelMode: TravelMode,
    signal?: AbortSignal,
  ): Promise<RoutePlan>;
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
  async describeProviders(signal) {
    const value = await invoke("maps-describe-providers", {}, signal);
    if (!isRecord(value)) {
      throw new Error("Maps returned invalid provider metadata.");
    }
    return z
      .array(mapsProviderDescriptionSchema)
      .max(32)
      .parse(value.providers);
  },
  async search(query, signal, cursor) {
    return placePageSchema.parse(
      await invoke(
        "maps-search-places",
        { query, limit: 24, ...(cursor ? { cursor } : {}) },
        signal,
      ),
    );
  },
  async getPlace(place, signal) {
    const value = await invoke(
      "maps-get-place",
      { placeId: place.providerPlaceId, provider: place.provider },
      signal,
    );
    if (!isRecord(value)) throw new Error("Maps returned invalid place data.");
    return value.place === null ? null : placeRefSchema.parse(value.place);
  },
  async planRoute(origin, destination, travelMode, signal) {
    const value = await invoke(
      "maps-plan-route",
      { origin, destination, travelMode, provider: destination.provider },
      signal,
    );
    if (!isRecord(value)) throw new Error("Maps returned invalid route data.");
    return routePlanSchema.parse(value.route);
  },
};
