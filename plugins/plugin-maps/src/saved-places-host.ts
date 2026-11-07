/**
 * Reconciles the agent's durable saved places with the places a host device
 * keeps in its own Maps list (for example a phone's installed-data namespace).
 * The host is read only when listing; nothing is copied between the stores,
 * and a host that cannot answer never hides the agent's own list.
 */

import { z } from "zod";
import { MapsError } from "./errors.js";
import { coordinatesSchema, type PlaceRef, type SavedPlace } from "./types.js";

/** One place saved on the host device. */
export interface MapsHostSavedPlace {
  /** The host's own row id. */
  id: string;
  label: string;
  coordinates: { latitude: number; longitude: number };
  /** Provider identity, present only when the host saved a provider place. */
  provider?: string;
  providerPlaceId?: string;
  /** Epoch milliseconds. */
  savedAt: number;
}

/** The host's Maps list, registered by the device host (null removes it). */
export interface MapsSavedPlacesHost {
  /** Installed-data namespace of the host list, for example `eliza.maps.saved-places.v1`. */
  readonly namespace: string;
  list(
    ownerEntityId: string,
    signal?: AbortSignal,
  ): Promise<readonly MapsHostSavedPlace[]>;
}

export type MapsSavedPlaceSource = "agent" | "device" | "both";

export interface ReconciledSavedPlace {
  label: string;
  place: PlaceRef;
  source: MapsSavedPlaceSource;
  /** The agent store row, when the agent has saved this place. */
  savedPlaceId?: string;
  /** The host row, when the device has saved this place. */
  deviceId?: string;
}

export interface SavedPlacesListing {
  places: ReconciledSavedPlace[];
  /** `listed`: the host answered; `unavailable`: it did not; `none`: no host is registered. */
  device: "listed" | "unavailable" | "none";
  namespace?: string;
}

const NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const hostRowSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
    label: z.string().trim().min(1).max(300),
    coordinates: coordinatesSchema,
    provider: z.string().trim().min(1).max(80).optional(),
    providerPlaceId: z.string().trim().min(1).max(512).optional(),
    savedAt: z.number().finite().positive(),
  })
  .strict()
  .refine(
    (row) =>
      (row.provider === undefined) === (row.providerPlaceId === undefined),
    "A provider place needs both its provider and place id.",
  );
const HOST_LIMIT = 200;

/** Validates a host's namespace once, at registration. */
export function assertSavedPlacesNamespace(namespace: string): void {
  if (!NAMESPACE.test(namespace))
    throw new MapsError("Saved-places namespace is invalid.", {
      code: "MAPS_INVALID_INPUT",
    });
}

/** Validates the host's answer; a malformed list is refused as a whole. */
export function parseHostSavedPlaces(value: unknown): MapsHostSavedPlace[] {
  if (!Array.isArray(value) || value.length > HOST_LIMIT)
    throw new MapsError("The device returned an invalid saved-places list.", {
      code: "MAPS_MALFORMED_RESPONSE",
    });
  const ids = new Set<string>();
  return value.map((row) => {
    const parsed = hostRowSchema.safeParse(row);
    if (!parsed.success || ids.has(parsed.data.id))
      throw new MapsError("The device returned an invalid saved-places list.", {
        code: "MAPS_MALFORMED_RESPONSE",
        ...(parsed.success ? {} : { cause: parsed.error }),
      });
    ids.add(parsed.data.id);
    return parsed.data;
  });
}

const sameCoordinates = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) =>
  Math.abs(a.latitude - b.latitude) < 1e-6 &&
  Math.abs(a.longitude - b.longitude) < 1e-6;

/** Same provider place, or (for coordinate-only rows) the same point. */
function samePlace(agent: SavedPlace, device: MapsHostSavedPlace): boolean {
  if (device.provider && agent.place.provider === device.provider)
    return agent.place.providerPlaceId === device.providerPlaceId;
  return (
    !device.provider &&
    sameCoordinates(agent.place.coordinates, device.coordinates)
  );
}

function devicePlace(row: MapsHostSavedPlace): PlaceRef {
  return {
    provider: row.provider ?? "coordinates",
    providerPlaceId:
      row.providerPlaceId ??
      `coordinates:${row.coordinates.latitude},${row.coordinates.longitude}`,
    name: row.label,
    coordinates: { ...row.coordinates },
    categories: [],
  };
}

/**
 * One list: the agent's places in store order (marked `both` when the device
 * has the same place), then device-only places, most recent first. The agent's
 * label wins for a place both keep; nothing is merged back into either store.
 */
export function reconcileSavedPlaces(
  agent: readonly SavedPlace[],
  device: readonly MapsHostSavedPlace[],
): ReconciledSavedPlace[] {
  const matched = new Set<string>();
  const places: ReconciledSavedPlace[] = agent.map((saved) => {
    const twin = device.find(
      (row) => !matched.has(row.id) && samePlace(saved, row),
    );
    if (twin) matched.add(twin.id);
    return {
      label: saved.label,
      place: saved.place,
      source: twin ? "both" : "agent",
      savedPlaceId: saved.id,
      ...(twin ? { deviceId: twin.id } : {}),
    };
  });
  for (const row of [...device]
    .filter((row) => !matched.has(row.id))
    .sort((a, b) => b.savedAt - a.savedAt))
    places.push({
      label: row.label,
      place: devicePlace(row),
      source: "device",
      deviceId: row.id,
    });
  return places;
}
