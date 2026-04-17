// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import {
  readDuffelConfigFromEnv,
  searchFlights,
  getOffer,
  type SearchFlightsRequest,
  type SearchFlightsResult,
  type DuffelOffer,
} from "./travel-adapters/duffel.js";

// ---------------------------------------------------------------------------
// Capability descriptor
// ---------------------------------------------------------------------------

/**
 * Capability descriptor for the travel connector.
 *
 * inbound:        false   — no inbound messages from travel providers.
 * outbound:       'partial' — search-only in v1; booking is deferred to WS6
 *                             (requires user approval flow before any order
 *                             creation).
 * search:         true    — flight offer search via Duffel Offer Requests API.
 * identity:       false   — no per-user identity linking.
 * attachments:    false   — no file attachments.
 * deliveryStatus: false   — not applicable (read-only search).
 *
 * Scope: flights only. Hotels and car hire are deferred to a future iteration.
 */
export const TRAVEL_CAPABILITIES = {
  inbound: false,
  outbound: "partial",
  search: true,
  identity: false,
  attachments: false,
  deliveryStatus: false,
} as const;

export type TravelCapabilities = typeof TRAVEL_CAPABILITIES;

// ---------------------------------------------------------------------------
// Connector status type
// ---------------------------------------------------------------------------

export interface TravelConnectorStatus {
  provider: "travel";
  connected: boolean;
  adapter: "duffel" | null;
  lastCheckedAt: string;
}

// ---------------------------------------------------------------------------
// Mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withTravel<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsTravelServiceMixin extends Base {
    getTravelConnectorStatus(): TravelConnectorStatus {
      try {
        readDuffelConfigFromEnv();
        return {
          provider: "travel",
          connected: true,
          adapter: "duffel",
          lastCheckedAt: new Date().toISOString(),
        };
      } catch {
        return {
          provider: "travel",
          connected: false,
          adapter: null,
          lastCheckedAt: new Date().toISOString(),
        };
      }
    }

    /**
     * Search for available flight offers.
     *
     * Throws `DuffelConfigError` when DUFFEL_API_KEY is absent.
     * Returns up to the full offer set from Duffel — callers should
     * limit display to the top-N cheapest or fastest offers.
     *
     * NOTE: This method is intentionally read-only. Booking requires a
     * separate user-approval flow — do not add a booking method here
     * without implementing WS6 approval gating first.
     */
    async searchFlights(
      request: SearchFlightsRequest,
    ): Promise<SearchFlightsResult> {
      const config = readDuffelConfigFromEnv();
      return searchFlights(request, config);
    }

    /**
     * Retrieve a specific offer by ID for detailed pricing.
     *
     * Use after searchFlights() to refresh pricing before presenting
     * a confirmed offer to the user for approval.
     *
     * NOTE: Read-only. Booking is not supported until WS6 is complete.
     */
    async getFlightOffer(offerId: string): Promise<DuffelOffer> {
      const config = readDuffelConfigFromEnv();
      return getOffer(offerId, config);
    }
  }

  return LifeOpsTravelServiceMixin;
}
