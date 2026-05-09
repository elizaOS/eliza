/**
 * W2-B — Duffel (travel) connector contribution.
 *
 * Wraps the Duffel travel adapter (`../travel-adapters/duffel.ts`).
 * Duffel is a travel-booking provider; like Calendly it has no outbound
 * `send`. Read verbs return flight offers + order state.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  DuffelConfigError,
  readDuffelConfigFromEnv,
  searchFlights,
  type SearchFlightsRequest,
} from "../travel-adapters/duffel.js";
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
    capabilities: [
      "duffel.flights.search",
      "duffel.offers.read",
      "duffel.orders.read",
      "duffel.orders.create",
    ],
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
          message: error instanceof Error ? error.message : String(error),
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
      return searchFlights(readDuffelConfigFromEnv(), params as SearchFlightsRequest);
    },
  };
}
