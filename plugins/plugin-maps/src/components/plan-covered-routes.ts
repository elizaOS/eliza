/**
 * Plans the Maps view's route comparison: one request per travel mode the
 * provider reports it serves. A coverage the view cannot read, or a transport
 * without a coverage read, narrows nothing, so no mode is refused on a guess.
 */

import { offeredTravelModes } from "../coverage.js";
import type {
  MapsProviderDescription,
  MapsRouteResult,
  PlaceRef,
  TravelMode,
} from "../types.js";
import type { MapsViewTransport } from "./maps-view-data.js";

export interface CoveredRoutePlan {
  /** Modes requested, in canonical display order. */
  modes: readonly TravelMode[];
  /** One settled outcome per requested mode, in the same order. */
  outcomes: PromiseSettledResult<MapsRouteResult>[];
}

/** Returns null when the signal aborted before any route was requested. */
export async function planCoveredRoutes(
  transport: Pick<MapsViewTransport, "planRoute" | "coverage">,
  origin: PlaceRef,
  destination: PlaceRef,
  provider: MapsProviderDescription,
  signal: AbortSignal,
): Promise<CoveredRoutePlan | null> {
  const coverage = transport.coverage
    ? await transport.coverage(provider, signal).catch(() => null)
    : null;
  if (signal.aborted) return null;
  const modes = offeredTravelModes(coverage);
  const outcomes = await Promise.allSettled(
    modes.map((mode) =>
      transport.planRoute(origin, destination, mode, provider, signal),
    ),
  );
  return { modes, outcomes };
}
