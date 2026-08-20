/**
 * Server-side producer for the routed /maps view snapshot. Builds the DTO from
 * the registered provider adapters and the owner's durable saved places; the
 * validated shape itself lives in `view-contract.ts`, which both the server
 * broker and the browser bundle share. Saved places are owner-scoped: when no
 * canonical owner entity is configured, the snapshot carries an explicit
 * unavailable state instead of a healthy-looking empty collection.
 */

import { type IAgentRuntime, resolveCanonicalOwnerId } from "@elizaos/core";
import type { MapsService } from "./service.js";
import type {
  MapsSavedPlacesState,
  MapsViewSnapshot,
} from "./view-contract.js";

export type {
  MapsSavedPlacesState,
  MapsViewProvider,
  MapsViewSnapshot,
  RouteAlternative,
} from "./view-contract.js";
export {
  mapsSavedPlacesStateSchema,
  mapsViewProviderSchema,
  mapsViewSnapshotSchema,
  routeAlternativeSchema,
} from "./view-contract.js";

export async function buildMapsViewSnapshot(
  runtime: IAgentRuntime,
  service: MapsService,
): Promise<MapsViewSnapshot> {
  const providers = service.describeProviders();
  const ownerEntityId = resolveCanonicalOwnerId(runtime);
  const savedPlaces: MapsSavedPlacesState = ownerEntityId
    ? { status: "ok", places: await service.listSavedPlaces(ownerEntityId) }
    : {
        status: "unavailable",
        reason:
          "Saved places require a configured owner entity for this agent.",
      };
  return {
    providers: [...providers],
    providerAvailable: providers.length > 0,
    savedPlaces,
  };
}
