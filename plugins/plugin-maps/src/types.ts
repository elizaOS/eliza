/** Defines and validates the provider-neutral maps domain contracts. */

import * as z from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const coordinatesSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

export const placeRefSchema = z
  .object({
    provider: boundedText(64).regex(/^[a-z0-9][a-z0-9_-]*$/i),
    providerPlaceId: boundedText(512),
    name: boundedText(300),
    coordinates: coordinatesSchema,
    formattedAddress: boundedText(1_000).optional(),
    categories: z.array(boundedText(80)).max(32).default([]),
  })
  .strict();

export const travelModeSchema = z.enum(["drive", "walk", "bicycle", "transit"]);

export const routePlanSchema = z
  .object({
    provider: boundedText(64).regex(/^[a-z0-9][a-z0-9_-]*$/i),
    routeId: boundedText(512),
    origin: placeRefSchema,
    destination: placeRefSchema,
    travelMode: travelModeSchema,
    distanceMeters: z.number().int().nonnegative(),
    durationSeconds: z.number().int().nonnegative(),
    encodedPolyline: boundedText(100_000).optional(),
    warnings: z.array(boundedText(500)).max(32).default([]),
  })
  .strict();

export const savedPlaceSchema = z
  .object({
    id: z.string().uuid(),
    ownerEntityId: z.string().uuid(),
    place: placeRefSchema,
    label: boundedText(120),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    idempotencyKey: boundedText(200).nullable(),
  })
  .strict();

export const placePageSchema = z
  .object({
    places: z.array(placeRefSchema).max(100),
    nextCursor: z.string().min(1).max(2_048).nullable(),
  })
  .strict();

export type Coordinates = z.infer<typeof coordinatesSchema>;
export type PlaceRef = z.infer<typeof placeRefSchema>;
export type TravelMode = z.infer<typeof travelModeSchema>;
export type RoutePlan = z.infer<typeof routePlanSchema>;
export type SavedPlace = z.infer<typeof savedPlaceSchema>;
export type PlacePage = z.infer<typeof placePageSchema>;

export interface PlaceSearchRequest {
  query: string;
  near?: Coordinates;
  cursor?: string;
  limit?: number;
}

export interface RoutePlanRequest {
  origin: PlaceRef;
  destination: PlaceRef;
  travelMode: TravelMode;
}

export interface SavePlaceRequest {
  ownerEntityId: string;
  roomId: string;
  place: PlaceRef;
  label?: string;
  idempotencyKey?: string;
}

export interface SavePlaceResult {
  savedPlace: SavedPlace;
  replayed: boolean;
  commitId: string;
}
