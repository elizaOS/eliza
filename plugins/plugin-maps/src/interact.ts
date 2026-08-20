/** Dispatches Maps view reads through the owning runtime service. */

import type { IAgentRuntime } from "@elizaos/core";
import { ZodError } from "zod";
import { MapsError } from "./errors.js";
import { getMapsService } from "./service.js";
import {
  placeRefSchema,
  placeSearchRequestSchema,
  routePlanRequestSchema,
} from "./types.js";

export type MapsInteractResult =
  | { success: true; text: string; data: unknown }
  | {
      success: false;
      text: string;
      error: { code: string; message: string; retryAfterMs?: number };
    };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredText(value: unknown, field: string): string {
  const parsed = optionalText(value);
  if (!parsed) {
    throw new MapsError(`Maps ${field} is required.`, {
      code: "MAPS_INVALID_INPUT",
    });
  }
  return parsed;
}

function expectedFailure(error: unknown): MapsInteractResult {
  if (error instanceof ZodError) {
    return {
      success: false,
      text: "Maps input is invalid.",
      error: {
        code: "MAPS_INVALID_INPUT",
        message: "Maps input is invalid.",
      },
    };
  }
  if (!(error instanceof MapsError)) throw error;
  return {
    success: false,
    text: error.message,
    error: {
      code: error.code,
      message: error.message,
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.retryAfterMs }),
    },
  };
}

export async function serverInteract(
  capability: string,
  params?: Record<string, unknown>,
  context?: { runtime?: IAgentRuntime },
): Promise<MapsInteractResult> {
  if (!context?.runtime) {
    throw new MapsError("Maps interaction requires an owning runtime.", {
      code: "MAPS_PROVIDER_UNAVAILABLE",
    });
  }
  const values = record(params);
  const provider = optionalText(values.provider);

  try {
    const service = getMapsService(context.runtime);
    switch (capability) {
      case "maps-search-places": {
        const request = placeSearchRequestSchema.parse({
          query: requiredText(values.query, "query"),
          ...(optionalText(values.cursor)
            ? { cursor: optionalText(values.cursor) }
            : {}),
          ...(typeof values.limit === "number" ? { limit: values.limit } : {}),
        });
        const page = await service.searchPlaces(request, provider);
        return {
          success: true,
          text: page.places.length
            ? `Found ${page.places.length} place${page.places.length === 1 ? "" : "s"}.`
            : "No matching places were found.",
          data: page,
        };
      }
      case "maps-get-place": {
        const place = await service.getPlace(
          requiredText(values.placeId, "place id"),
          provider,
        );
        return {
          success: true,
          text: place ? `Found ${place.name}.` : "No matching place was found.",
          data: { place },
        };
      }
      case "maps-plan-route": {
        const request = routePlanRequestSchema.parse({
          origin: placeRefSchema.parse(values.origin),
          destination: placeRefSchema.parse(values.destination),
          travelMode: values.travelMode,
        });
        const route = await service.planRoute(request, provider);
        return {
          success: true,
          text: `Planned a ${route.travelMode} route.`,
          data: { route },
        };
      }
      default:
        throw new MapsError(
          `Maps does not support capability "${capability}".`,
          {
            code: "MAPS_INVALID_INPUT",
          },
        );
    }
  } catch (error) {
    // error-policy:J1 expected maps-domain failures become typed broker results;
    // systemic failures continue to the shared view route boundary.
    return expectedFailure(error);
  }
}
