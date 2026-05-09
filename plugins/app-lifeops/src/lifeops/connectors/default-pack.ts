/**
 * W1-F — Default connector pack entry point.
 *
 * Wave 1 ships an EMPTY pack: this file exists so the registration entry point
 * is stable and Wave 2 (W2-B) can populate the 12 connector contributions
 * without further repo restructuring.
 *
 * W1-B (`plugin-health`) registers its own connector contributions
 * (`apple_health`, `google_fit`, `strava`, `fitbit`, `withings`, `oura`)
 * directly via {@link import("./contract.js").ConnectorRegistry.register}; it
 * does NOT go through this default-pack entry point.
 */

import type {
  ConnectorContribution,
  ConnectorRegistry,
} from "./contract.js";

/**
 * Empty in Wave 1 — Wave 2 W2-B populates this list with the migrated
 * connector contributions.
 */
export const DEFAULT_CONNECTOR_PACK: readonly ConnectorContribution[] = [];

/**
 * Register every connector in the default pack against the supplied registry.
 *
 * Wave 1: no-op (the pack is empty). Wave 2: registers the 12 migrated
 * connectors. Idempotency is the registry's responsibility — re-registering
 * the same `kind` is a programming error and surfaces as a thrown `Error`.
 */
export function registerDefaultConnectorPack(registry: ConnectorRegistry): void {
  for (const contribution of DEFAULT_CONNECTOR_PACK) {
    registry.register(contribution);
  }
}
