/**
 * @module plugin-calendly
 * @description elizaOS plugin for Calendly integration.
 *
 * Actions:
 *   - LIST_CALENDLY_EVENT_TYPES
 *   - BOOK_CALENDLY_SLOT
 *   - CANCEL_CALENDLY_BOOKING
 *
 * Auth: single Calendly v2 personal access token, resolved from
 * `CALENDLY_ACCESS_TOKEN` with a `MILADY_E2E_CALENDLY_ACCESS_TOKEN` fallback
 * for E2E runs.
 *
 * Webhook: POST /calendly/webhook validates the envelope and emits a
 * `CALENDLY_WEBHOOK` runtime event. Signature verification against
 * `CALENDLY_WEBHOOK_SIGNING_KEY` is deferred.
 */

import type { Plugin } from "@elizaos/core";
import { bookSlotAction } from "./actions/book-slot.js";
import { cancelBookingAction } from "./actions/cancel-booking.js";
import { listEventTypesAction } from "./actions/list-event-types.js";
import { calendlyWebhookRoute } from "./routes/webhook.js";
import { CalendlyService } from "./services/CalendlyService.js";

export { bookSlotAction } from "./actions/book-slot.js";
export { cancelBookingAction } from "./actions/cancel-booking.js";
export { listEventTypesAction } from "./actions/list-event-types.js";
export type { FetchLike } from "./calendly-client.js";
export { CalendlyApiError, CalendlyClient } from "./calendly-client.js";
export { calendlyWebhookRoute } from "./routes/webhook.js";
export { CalendlyService } from "./services/CalendlyService.js";
export * from "./types.js";

export const calendlyPlugin: Plugin = {
  name: "calendly",
  description:
    "Calendly integration — list event types, hand off booking links, cancel scheduled events",
  services: [CalendlyService],
  actions: [listEventTypesAction, bookSlotAction, cancelBookingAction],
  routes: [calendlyWebhookRoute],
  autoEnable: {
    envKeys: ["CALENDLY_ACCESS_TOKEN", "MILADY_E2E_CALENDLY_ACCESS_TOKEN"],
  },
};

export default calendlyPlugin;
