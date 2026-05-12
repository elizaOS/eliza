/**
 * @module calendly-client (lifeops shim)
 * @description Backwards-compatible shim that re-exports from
 * @elizaos/plugin-calendly. The canonical Calendly API client now lives in
 * plugin-calendly so the plugin owns all Calendly integration. This shim
 * preserves the original lifeops surface (CalendlyEventType, CalendlyScheduledEvent,
 * etc.) so existing callers keep compiling while we migrate to importing
 * directly from @elizaos/plugin-calendly.
 */

export type {
  CalendlyAvailabilityNormalized as CalendlyAvailability,
  CalendlyCredentials,
  CalendlyEventTypeNormalized as CalendlyEventType,
  CalendlyScheduledEventNormalized as CalendlyScheduledEvent,
  CalendlySingleUseLink,
} from "@elizaos/plugin-calendly";
export {
  CalendlyError,
  cancelCalendlyScheduledEvent,
  createCalendlySingleUseLink,
  getCalendlyAvailability,
  getCalendlyUser,
  listCalendlyEventTypes,
  listCalendlyScheduledEvents,
  readCalendlyCredentialsFromEnv,
} from "@elizaos/plugin-calendly";
