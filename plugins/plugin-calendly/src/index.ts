/**
 * @module plugin-calendly
 * @description elizaOS plugin for Calendly integration.
 *
 * Surface:
 *   - CALENDLY_OP { op: "book" | "cancel" } — unified booking + cancellation router
 *   - calendlyEventTypes — read-only provider for the connected user's event types
 *
 * Auth: Calendly v2 personal access token resolved from CALENDLY_ACCESS_TOKEN
 * (with ELIZA_E2E_CALENDLY_ACCESS_TOKEN as the E2E fallback) or via OAuth
 * through the ConnectorAccountManager (CALENDLY_OAUTH_CLIENT_ID / CALENDLY_OAUTH_CLIENT_SECRET / CALENDLY_OAUTH_REDIRECT_URI).
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  getConnectorAccountManager,
  logger,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { calendlyOpAction } from "./actions/calendly-op.js";
import { createCalendlyConnectorAccountProvider } from "./connector-account-provider.js";
import { calendlyEventTypesProvider } from "./providers/calendly-event-types.js";
import { CalendlyService } from "./services/CalendlyService.js";

export * from "./accounts.js";
export {
  type CalendlyAvailabilityNormalized,
  type CalendlyCredentials,
  CalendlyError,
  type CalendlyEventTypeNormalized,
  type CalendlyScheduledEventNormalized,
  type CalendlySingleUseLink,
  cancelCalendlyScheduledEvent,
  createCalendlySingleUseLink,
  getCalendlyAvailability,
  getCalendlyUser,
  listCalendlyEventTypes,
  listCalendlyScheduledEvents,
  readCalendlyCredentialsFromEnv,
} from "./calendly-client.js";
export { calendlyOpAction } from "./actions/calendly-op.js";
export { createCalendlyConnectorAccountProvider } from "./connector-account-provider.js";
export { calendlyEventTypesProvider } from "./providers/calendly-event-types.js";
export { CalendlyService } from "./services/CalendlyService.js";
export * from "./types.js";

export const calendlyPlugin: Plugin = {
  name: "calendly",
  description:
    "Calendly integration -- list event types, hand off booking links, cancel scheduled events",
  services: [CalendlyService],
  actions: [...promoteSubactionsToActions(calendlyOpAction)],
  providers: [calendlyEventTypesProvider],
  autoEnable: {
    envKeys: [
      "CALENDLY_ACCESS_TOKEN",
      "CALENDLY_ACCOUNTS",
      "ELIZA_E2E_CALENDLY_ACCESS_TOKEN",
    ],
  },
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createCalendlyConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:calendly",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Calendly provider with ConnectorAccountManager",
      );
    }
  },
};

export default calendlyPlugin;
