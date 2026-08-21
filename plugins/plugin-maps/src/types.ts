/** Defines and validates the provider-neutral maps domain contracts. */

import * as z from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const opaqueText = (max: number) => z.string().min(1).max(max);

export const MAX_MAPS_PROVIDERS = 32;
export const MAX_MAPS_PROVIDER_ID_LENGTH = 64;
export const MAX_MAPS_ATTRIBUTION_LENGTH = 500;
export const MAX_MAPS_PROVIDER_GENERATION = Number.MAX_SAFE_INTEGER;

/** Validates the canonical identity used to join adapter and browser metadata. */
export const mapsProviderIdSchema = z
  .string()
  .min(1)
  .max(MAX_MAPS_PROVIDER_ID_LENGTH)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i);

/** Trims bounded provider-owned legal text while rejecting blank attribution. */
export const mapsAttributionSchema = z
  .string()
  .max(MAX_MAPS_ATTRIBUTION_LENGTH)
  .trim()
  .min(1);

/** Couples one canonical provider id to legal text or explicit unavailability. */
export const mapsProviderGenerationSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_MAPS_PROVIDER_GENERATION);

export const mapsProviderDescriptionSchema = z
  .object({
    id: mapsProviderIdSchema,
    attribution: mapsAttributionSchema.nullable(),
    generation: mapsProviderGenerationSchema,
  })
  .strict();

export const mapsProviderIdsSchema = z
  .array(mapsProviderIdSchema)
  .max(MAX_MAPS_PROVIDERS)
  .refine((providers) => new Set(providers).size === providers.length, {
    message: "Maps provider lookup ids must be unique.",
  });

export const mapsProviderDescriptionsSchema = z
  .array(mapsProviderDescriptionSchema)
  .max(MAX_MAPS_PROVIDERS)
  .refine(
    (providers) =>
      new Set(providers.map((provider) => provider.id)).size ===
      providers.length,
    { message: "Maps provider metadata must contain unique provider ids." },
  );

/** Accepts canonical UUIDs, including deterministic elizaOS version-0 IDs. */
export const elizaUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

export const coordinatesSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

export const coordinateBindingSchema = z
  .object({
    provider: z.literal("coordinates"),
    providerPlaceId: opaqueText(512),
    coordinates: coordinatesSchema,
  })
  .strict();

export const placeRefSchema = z
  .object({
    provider: boundedText(64).regex(/^[a-z0-9][a-z0-9_-]*$/i),
    providerPlaceId: opaqueText(512),
    name: boundedText(300),
    coordinates: coordinatesSchema,
    formattedAddress: boundedText(1_000).optional(),
    categories: z.array(boundedText(80)).max(32).default([]),
    /** Original coordinate identity retained when a provider canonicalizes it. */
    coordinateBinding: coordinateBindingSchema.optional(),
  })
  .strict();

export const travelModeSchema = z.enum(["drive", "walk", "bicycle", "transit"]);

export const routePlanSchema = z
  .object({
    provider: boundedText(64).regex(/^[a-z0-9][a-z0-9_-]*$/i),
    routeId: opaqueText(512),
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
    id: elizaUuidSchema,
    ownerEntityId: elizaUuidSchema,
    place: placeRefSchema,
    label: boundedText(120),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const placePageSchema = z
  .object({
    places: z.array(placeRefSchema).max(100),
    nextCursor: opaqueText(2_048).nullable(),
  })
  .strict();

/** Binds one page to the exact adapter registration that generated it. */
export const mapsPlacePageResultSchema = z
  .object({
    page: placePageSchema,
    provider: mapsProviderDescriptionSchema,
  })
  .strict()
  .refine(
    (result) =>
      result.page.places.every(
        (place) => place.provider === result.provider.id,
      ),
    { message: "Maps page provider binding does not match its places." },
  );

/** Binds one detail read to the exact adapter registration that generated it. */
export const mapsPlaceResultSchema = z
  .object({
    place: placeRefSchema.nullable(),
    provider: mapsProviderDescriptionSchema,
  })
  .strict()
  .refine(
    (result) =>
      result.place === null || result.place.provider === result.provider.id,
    { message: "Maps detail provider binding does not match its place." },
  );

/** Binds one route to the exact adapter registration that generated it. */
export const mapsRouteResultSchema = z
  .object({
    route: routePlanSchema,
    provider: mapsProviderDescriptionSchema,
  })
  .strict()
  .refine((result) => result.route.provider === result.provider.id, {
    message: "Maps route provider binding does not match its route.",
  });

export const placeSearchRequestSchema = z
  .object({
    query: boundedText(500),
    near: coordinatesSchema.optional(),
    cursor: opaqueText(2_048).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const routePlanRequestSchema = z
  .object({
    origin: placeRefSchema,
    destination: placeRefSchema,
    travelMode: travelModeSchema,
  })
  .strict();

export type Coordinates = z.infer<typeof coordinatesSchema>;
export type MapsProviderDescription = z.infer<
  typeof mapsProviderDescriptionSchema
>;
export type CoordinateBinding = z.infer<typeof coordinateBindingSchema>;
export type PlaceRef = z.infer<typeof placeRefSchema>;
export type TravelMode = z.infer<typeof travelModeSchema>;
export type RoutePlan = z.infer<typeof routePlanSchema>;
export type SavedPlace = z.infer<typeof savedPlaceSchema>;
export type PlacePage = z.infer<typeof placePageSchema>;
export type MapsPlacePageResult = z.infer<typeof mapsPlacePageResultSchema>;
export type MapsPlaceResult = z.infer<typeof mapsPlaceResultSchema>;
export type MapsRouteResult = z.infer<typeof mapsRouteResultSchema>;

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
  committedAt: string;
  idempotencyKey: string;
  /** False when this historical operation was superseded by a later update. */
  currentlyApplied: boolean;
  /** Current durable state for the same resource, if it still exists. */
  currentSavedPlace: SavedPlace | null;
}
