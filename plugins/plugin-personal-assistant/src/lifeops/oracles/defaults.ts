/**
 * Production oracle pack assembled from runtime-owned secret resolution.
 *
 * Construction is side-effect free; plugin initialization owns registration so
 * tests and alternative deployments can replace individual source adapters.
 */

import { GoogleRoutesMatrixAdapter } from "./google-routes.js";
import { NwsForecastAdapter } from "./nws.js";
import {
  ExternalOracleRegistry,
  LocalActivityAdapterRegistry,
} from "./registry.js";
import { TicketmasterDiscoveryAdapter } from "./ticketmaster.js";

export interface OracleRuntimeSettings {
  getSetting(key: string): unknown;
}

export interface DefaultOraclePack {
  external: ExternalOracleRegistry;
  localActivities: LocalActivityAdapterRegistry;
}

export function createDefaultOraclePack(
  runtime: OracleRuntimeSettings,
): DefaultOraclePack {
  const external = new ExternalOracleRegistry();
  const localActivities = new LocalActivityAdapterRegistry();
  const weather = new NwsForecastAdapter();
  const routes = new GoogleRoutesMatrixAdapter({
    apiKeyResolver: () => readRuntimeSecret(runtime, "GOOGLE_MAPS_API_KEY"),
  });
  const ticketmaster = new TicketmasterDiscoveryAdapter({
    apiKeyResolver: () => readRuntimeSecret(runtime, "TICKETMASTER_API_KEY"),
  });

  external.register(weather);
  external.register(routes);
  external.register(ticketmaster);
  localActivities.register("ticketmaster", ticketmaster);
  return { external, localActivities };
}

function readRuntimeSecret(
  runtime: OracleRuntimeSettings,
  key: string,
): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
