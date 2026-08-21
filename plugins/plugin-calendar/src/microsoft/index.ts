/** Microsoft delegated-account resolution and Graph calendar provider port. */
export {
  capabilitiesForScopes as microsoftCapabilitiesForScopes,
  DefaultMicrosoftCalendarTokenResolver,
  isMicrosoftCalendarGrantId,
  listMicrosoftCalendarAccounts,
  MICROSOFT_CALENDAR_GRANT_PREFIX,
  MICROSOFT_CALENDAR_PROVIDER,
  type MicrosoftCalendarAccessToken,
  type MicrosoftCalendarAccount,
  type MicrosoftCalendarTokenResolver,
  microsoftAccountIdFromGrantId,
} from "./accounts.js";
export { createMicrosoftConnectorAccountProvider } from "./connector-account-provider.js";
export {
  DefaultMicrosoftGraphCalendarPort,
  type MicrosoftGraphCalendarPort,
  type MicrosoftGraphCalendarSummary,
  type MicrosoftGraphCalendarSyncBatch,
  MicrosoftGraphDeltaExpiredError,
  type MicrosoftGraphEvent,
  type MicrosoftGraphEventChange,
  MicrosoftGraphRequestError,
  type MicrosoftGraphScheduleInterval,
  type MicrosoftGraphScheduleResult,
} from "./graph.js";
