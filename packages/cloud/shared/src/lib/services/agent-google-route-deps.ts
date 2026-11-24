// Coordinates cloud service agent google route deps behavior behind route handlers.
import { requireAuthOrApiKeyWithOrg } from "../auth";
import { requireMailUser } from "../auth/workers-hono-auth";
import {
  AgentGoogleConnectorError,
  createManagedGoogleCalendarEvent,
  deleteManagedGoogleCalendarEvent,
  disconnectManagedGoogleConnection,
  fetchManagedGoogleCalendarFeed,
  fetchManagedGoogleGmailSearch,
  fetchManagedGoogleGmailSubscriptionHeaders,
  fetchManagedGoogleGmailTriage,
  getManagedGoogleConnectorStatus,
  initiateManagedGoogleConnection,
  listManagedGoogleCalendars,
  listManagedGoogleConnectorAccounts,
  readManagedGoogleGmailMessage,
  sendManagedGoogleMessage,
  sendManagedGoogleReply,
  updateManagedGoogleCalendarEvent,
} from "./agent-google-connector";

export const agentGoogleRouteDeps = {
  requireAuthOrApiKeyWithOrg,
  requireMailUser,
  getManagedGoogleConnectorStatus,
  listManagedGoogleConnectorAccounts,
  listManagedGoogleCalendars,
  initiateManagedGoogleConnection,
  disconnectManagedGoogleConnection,
  fetchManagedGoogleCalendarFeed,
  createManagedGoogleCalendarEvent,
  updateManagedGoogleCalendarEvent,
  deleteManagedGoogleCalendarEvent,
  fetchManagedGoogleGmailSearch,
  fetchManagedGoogleGmailSubscriptionHeaders,
  fetchManagedGoogleGmailTriage,
  readManagedGoogleGmailMessage,
  sendManagedGoogleMessage,
  sendManagedGoogleReply,
  AgentGoogleConnectorError,
};
