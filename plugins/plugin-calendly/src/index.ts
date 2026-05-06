/**
 * @module plugin-calendly
 * @description elizaOS plugin for Calendly integration.
 *
 * Surface:
 *   - CALENDLY_OP { op: "book" | "cancel" } — unified booking + cancellation router
 *   - calendlyEventTypes — read-only TOON provider for the connected user's event types
 *
 * Auth: single Calendly v2 personal access token, resolved from
 * `CALENDLY_ACCESS_TOKEN` with a `ELIZA_E2E_CALENDLY_ACCESS_TOKEN` fallback
 * for E2E runs.
 *
 * Webhook: POST /calendly/webhook validates the envelope and emits a
 * `CALENDLY_WEBHOOK` runtime event.
 */

import type { Plugin } from "@elizaos/core";
import { calendlyOpAction } from "./actions/calendly-op.js";
import { calendlyEventTypesProvider } from "./providers/calendly-event-types.js";
import { calendlyWebhookRoute } from "./routes/webhook.js";
import { CalendlyService } from "./services/CalendlyService.js";

export { calendlyOpAction } from "./actions/calendly-op.js";
export type { FetchLike } from "./calendly-client.js";
export { CalendlyApiError, CalendlyClient } from "./calendly-client.js";
export { calendlyEventTypesProvider } from "./providers/calendly-event-types.js";
export { calendlyWebhookRoute } from "./routes/webhook.js";
export { CalendlyService } from "./services/CalendlyService.js";
export * from "./types.js";

export const calendlyPlugin: Plugin = {
  name: "calendly",
  description:
    "Calendly integration — book or cancel slots, with event types surfaced as a read-only provider",
  services: [CalendlyService],
  actions: [calendlyOpAction],
  providers: [calendlyEventTypesProvider],
  routes: [calendlyWebhookRoute],
  autoEnable: {
    envKeys: ["CALENDLY_ACCESS_TOKEN", "ELIZA_E2E_CALENDLY_ACCESS_TOKEN"],
  },
};

export default calendlyPlugin;
