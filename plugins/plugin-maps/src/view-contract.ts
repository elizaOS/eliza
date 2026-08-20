/**
 * Shared zod contract for the routed /maps view transport. This module is
 * bundled into the browser view, so it must stay free of runtime imports —
 * only zod and the domain type schemas. The server-side snapshot producer
 * lives in `view-state.ts`.
 */

import * as z from "zod";
import {
  routePlanSchema,
  savedPlaceSchema,
  travelModeSchema,
} from "./types.js";

export const mapsViewProviderSchema = z
  .object({
    id: z.string().min(1).max(64),
    attribution: z.string().min(1).max(500).nullable(),
    isDefault: z.boolean(),
  })
  .strict();

export const mapsSavedPlacesStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      places: z.array(savedPlaceSchema).max(100),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.string().min(1).max(500),
    })
    .strict(),
]);

export const mapsViewSnapshotSchema = z
  .object({
    providers: z.array(mapsViewProviderSchema).max(32),
    /** True only when a default adapter can serve search and route reads. */
    providerAvailable: z.boolean(),
    savedPlaces: mapsSavedPlacesStateSchema,
  })
  .strict();

/**
 * One per-travel-mode outcome from `plan-route-alternatives`. A mode the
 * provider cannot serve is an explicit error entry, never a silently missing
 * row, so the view can render partial availability truthfully.
 */
export const routeAlternativeSchema = z.discriminatedUnion("status", [
  z
    .object({
      travelMode: travelModeSchema,
      status: z.literal("ok"),
      route: routePlanSchema,
    })
    .strict(),
  z
    .object({
      travelMode: travelModeSchema,
      status: z.literal("error"),
      code: z.string().min(1).max(120),
      message: z.string().min(1).max(1_000),
    })
    .strict(),
]);

export type MapsViewProvider = z.infer<typeof mapsViewProviderSchema>;
export type MapsSavedPlacesState = z.infer<typeof mapsSavedPlacesStateSchema>;
export type MapsViewSnapshot = z.infer<typeof mapsViewSnapshotSchema>;
export type RouteAlternative = z.infer<typeof routeAlternativeSchema>;
