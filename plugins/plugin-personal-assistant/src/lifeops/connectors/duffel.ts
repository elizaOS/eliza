/**
 * Duffel (travel) connector contribution.
 *
 * Wraps the Duffel travel client from `@elizaos/plugin-elizacloud`.
 * Duffel is a travel-booking provider; like Calendly it has no outbound
 * `send`. Read verbs return flight offers + order state.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { formatError } from "@elizaos/core";
import {
  DuffelConfigError,
  readDuffelConfigFromEnv,
  type SearchFlightsRequest,
  searchFlights,
} from "@elizaos/plugin-elizacloud/cloud/duffel-client";
import type {
  ConnectorContribution,
  ConnectorStatus,
  DispatchResult,
} from "./contract.js";

export function createDuffelConnectorContribution(
  _runtime: IAgentRuntime,
): ConnectorContribution {
  return {
    kind: "duffel",
    // Only what this contribution actually serves: `read` performs a flight
    // search (which returns offers). It has no order read/create path — those
    // must not be advertised, or `registry.byCapability("duffel.orders.create")`
    // resolves a connector that only searches flights (real order creation lives
    // on LifeOpsService.bookFlightItinerary → travel-service). (#10721)
    capabilities: ["duffel.flights.search", "duffel.offers.read"],
    modes: ["cloud", "local"],
    describe: { label: "Duffel (Travel)" },
    async start() {},
    async disconnect() {
      // Duffel mode is configured via env vars; LifeOps doesn't manage the
      // credential lifecycle.
    },
    async verify(): Promise<boolean> {
      try {
        readDuffelConfigFromEnv();
        return true;
      } catch (error) {
        if (error instanceof DuffelConfigError) return false;
        throw error;
      }
    },
    async status(): Promise<ConnectorStatus> {
      const observedAt = new Date().toISOString();
      try {
        const config = readDuffelConfigFromEnv();
        return {
          state: "ok",
          message: `mode=${config.mode}`,
          observedAt,
        };
      } catch (error) {
        return {
          state: "disconnected",
          message: formatError(error),
          observedAt,
        };
      }
    },
    // Duffel has no outbound `send` — the typed refusal lets the runner's
    // dispatch policy surface the misuse rather than silently no-op'ing.
    async send(): Promise<DispatchResult> {
      return {
        ok: false,
        reason: "transport_error",
        userActionable: false,
        message:
          "Duffel does not support outbound send. Use the search/order verbs to book travel.",
      };
    },
    async read(query: unknown) {
      const params = (query ?? {}) as Partial<SearchFlightsRequest>;
      if (!params.origin || !params.destination || !params.departureDate) {
        throw new Error(
          "duffel.read requires { origin, destination, departureDate, passengers, cabinClass }",
        );
      }
      return searchFlights(
        params as SearchFlightsRequest,
        readDuffelConfigFromEnv(),
      );
    },
  };
}
