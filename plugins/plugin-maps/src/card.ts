/**
 * Maps chat-card wire format: the `[MAPSCARD]` bracket marker an action appends
 * to user-facing text so chat surfaces can render place, route, handoff, and
 * locate cards instead of raw prose. The dashboard's inline maps widget
 * (`packages/ui/src/components/chat/message-maps-parser.ts`) parses this exact
 * shape; connectors without the widget show the surrounding prose unchanged.
 * Payloads carry only display-safe fields — never provider credentials,
 * encoded polylines, or opaque pagination cursors beyond the cursor itself.
 */

import type { MapsHandoff } from "./service.js";
import type { PlaceRef, RoutePlan, TravelMode } from "./types.js";

/** Display projection of a `PlaceRef` embedded in a card payload. */
export interface MapsCardPlace {
  name: string;
  latitude: number;
  longitude: number;
  provider: string;
  providerPlaceId: string;
  formattedAddress?: string;
  categories: string[];
}

export interface MapsPlaceCard {
  kind: "place";
  place: MapsCardPlace;
  /** Adapter-owned legal attribution for this result, or `null` when the
   * registered provider carries none. Never fabricated here — sourced from
   * `MapsProviderDescription.attribution` on the `...Result` service calls. */
  attribution: string | null;
}

export interface MapsPlacesCard {
  kind: "places";
  query: string;
  places: MapsCardPlace[];
  nextCursor: string | null;
  attribution: string | null;
}

export interface MapsRouteCard {
  kind: "route";
  origin: MapsCardPlace;
  destination: MapsCardPlace;
  travelMode: TravelMode;
  distanceMeters: number;
  durationSeconds: number;
  warnings: string[];
  attribution: string | null;
}

export interface MapsHandoffCard {
  kind: "handoff";
  handoffKind: "share" | "navigate";
  place: MapsCardPlace;
  /** Android/system `geo:` intent URI. */
  geoUri: string;
  /** Apple Maps universal link. */
  appleMapsUri: string;
  /** Provider-neutral browser fallback (OpenStreetMap). */
  webUri: string;
  /** Present on confirmed shares only — the user-visible share receipt time. */
  sharedAt?: string;
}

/**
 * Rendered when the request referenced the user's current position but no
 * coordinates were supplied: the widget collects a precise device location
 * (after the platform permission prompt) and replies with the coordinates.
 */
export interface MapsLocateCard {
  kind: "locate";
  intent: "place-near" | "route-origin";
  prompt: string;
}

export type MapsCard =
  | MapsPlaceCard
  | MapsPlacesCard
  | MapsRouteCard
  | MapsHandoffCard
  | MapsLocateCard;

export const MAPS_CARD_OPEN = "[MAPSCARD]";
export const MAPS_CARD_CLOSE = "[/MAPSCARD]";

/** Search-result cards cap rendered places; further results stay paginated. */
export const MAPS_CARD_MAX_PLACES = 10;

export function toCardPlace(place: PlaceRef): MapsCardPlace {
  return {
    name: place.name,
    latitude: place.coordinates.latitude,
    longitude: place.coordinates.longitude,
    provider: place.provider,
    providerPlaceId: place.providerPlaceId,
    ...(place.formattedAddress
      ? { formattedAddress: place.formattedAddress }
      : {}),
    categories: [...place.categories],
  };
}

export function routeCard(
  route: RoutePlan,
  attribution: string | null,
): MapsRouteCard {
  return {
    kind: "route",
    origin: toCardPlace(route.origin),
    destination: toCardPlace(route.destination),
    travelMode: route.travelMode,
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    warnings: [...route.warnings],
    attribution,
  };
}

export function handoffCard(
  handoff: MapsHandoff,
  sharedAt?: string,
): MapsHandoffCard {
  return {
    kind: "handoff",
    handoffKind: handoff.kind,
    place: toCardPlace(handoff.place),
    geoUri: handoff.uri,
    appleMapsUri: handoff.appleMapsUri,
    webUri: handoff.webUri,
    ...(sharedAt ? { sharedAt } : {}),
  };
}

export function serializeMapsCard(card: MapsCard): string {
  return `${MAPS_CARD_OPEN}\n${JSON.stringify(card)}\n${MAPS_CARD_CLOSE}`;
}

/** Append a card marker to `text` with a separating blank line when needed. */
export function appendMapsCard(text: string, card: MapsCard): string {
  const marker = serializeMapsCard(card);
  if (!text.trim()) return marker;
  return `${text.replace(/\s+$/, "")}\n\n${marker}`;
}
