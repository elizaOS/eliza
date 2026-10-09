// Coordinates cloud service agent google connector behavior behind route handlers.
export {
  createManagedGoogleCalendarEvent,
  deleteManagedGoogleCalendarEvent,
  fetchManagedGoogleCalendarFeed,
  listManagedGoogleCalendars,
  updateManagedGoogleCalendarEvent,
} from "./calendar";
export {
  fetchManagedGoogleGmailSearch,
  fetchManagedGoogleGmailSubscriptionHeaders,
  fetchManagedGoogleGmailTriage,
  readManagedGoogleGmailMessage,
  sendManagedGoogleMessage,
  sendManagedGoogleReply,
} from "./gmail";
export { readManagedGoogleGmailAttachment } from "./gmail-attachments";
export {
  type AgentGoogleCapability,
  AgentGoogleConnectorError,
  disconnectManagedGoogleConnection,
  getManagedGoogleConnectorStatus,
  initiateManagedGoogleConnection,
  listManagedGoogleConnectorAccounts,
  type ManagedGoogleCalendarEvent,
  type ManagedGoogleCalendarSummary,
  type ManagedGoogleConnectorStatus,
  type ManagedGoogleGmailMessage,
  type ManagedGoogleGmailReadResult,
  type ManagedGoogleGmailSearchResult,
  type ManagedGoogleGmailSubscriptionHeader,
  type ManagedGoogleGmailSubscriptionHeadersResult,
  managedGoogleConnectorDeps,
} from "./shared";
