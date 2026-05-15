/**
 * Default connector pack.
 *
 * Registers the LifeOps connector contributions with the `ConnectorRegistry`.
 * `plugin-health` registers its own health connectors directly; this pack
 * does not touch them.
 *
 * Channels (in_app, push, imessage, telegram, …) are registered separately
 * by `../channels/default-pack.ts`.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { createCalendlyConnectorContribution } from "./calendly.js";
import type { ConnectorContribution, ConnectorRegistry } from "./contract.js";
import { createDiscordConnectorContribution } from "./discord.js";
import { createDuffelConnectorContribution } from "./duffel.js";
import { createGoogleConnectorContribution } from "./google.js";
import { createIMessageConnectorContribution } from "./imessage.js";
import { createSignalConnectorContribution } from "./signal.js";
import { createTelegramConnectorContribution } from "./telegram.js";
import { createTwilioConnectorContribution } from "./twilio.js";
import { createWhatsAppConnectorContribution } from "./whatsapp.js";
import { createXConnectorContribution } from "./x.js";

export type ConnectorContributionFactory = (
  runtime: IAgentRuntime,
) => ConnectorContribution;

/**
 * Connector contributions ordered by usage frequency for deterministic
 * registration logs. plugin-health registers
 * apple_health/google_fit/strava/fitbit/withings/oura on its own; they
 * are not part of this pack.
 */
export const DEFAULT_CONNECTOR_CONTRIBUTIONS: ReadonlyArray<ConnectorContributionFactory> =
  [
    createGoogleConnectorContribution,
    createTelegramConnectorContribution,
    createDiscordConnectorContribution,
    createSignalConnectorContribution,
    createWhatsAppConnectorContribution,
    createIMessageConnectorContribution,
    createXConnectorContribution,
    createTwilioConnectorContribution,
    createCalendlyConnectorContribution,
    createDuffelConnectorContribution,
  ];

/**
 * Empty default — populating against a synthetic runtime would require
 * constructing `LifeOpsService` without a real runtime. Callers that want a
 * concrete list should call {@link registerDefaultConnectorPack}.
 */
export const DEFAULT_CONNECTOR_PACK: readonly ConnectorContribution[] = [];

/**
 * Register every connector in the default pack against the supplied registry.
 *
 * Each contribution is constructed lazily via its factory so the wrapper
 * captures the runtime reference. Re-registering the same `kind` is a
 * programming error and surfaces as a thrown `Error` from the registry.
 */
export function registerDefaultConnectorPack(
  registry: ConnectorRegistry,
  runtime?: IAgentRuntime,
): void {
  if (!runtime) {
    // Some callsites pass only the registry; preserve that path so the
    // plugin doesn't fail-fast before the rest of the boot sequence runs.
    return;
  }
  for (const factory of DEFAULT_CONNECTOR_CONTRIBUTIONS) {
    registry.register(factory(runtime));
  }
}
