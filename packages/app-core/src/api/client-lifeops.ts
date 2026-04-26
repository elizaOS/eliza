import type {
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailRecommendationsRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGmailManageResult,
  LifeOpsGmailNeedsResponseFeed,
  LifeOpsGmailRecommendationsFeed,
  LifeOpsGmailSearchFeed,
  LifeOpsGmailTriageFeed,
  LifeOpsGmailUnrespondedFeed,
  LifeOpsGoogleConnectorStatus,
  ListLifeOpsCalendarsRequest,
  ManageLifeOpsGmailMessagesRequest,
  SetLifeOpsCalendarIncludedRequest,
} from "@elizaos/app-lifeops";
import { ElizaClient } from "./client-base";

declare module "./client-base" {
  interface ElizaClient {
    getLifeOpsAppState(): Promise<{
      enabled: boolean;
      priorityScoring: { enabled: boolean; model: string | null };
    }>;
    updateLifeOpsAppState(data: {
      enabled: boolean;
      priorityScoring?: { enabled: boolean; model: string | null } | null;
    }): Promise<{
      enabled: boolean;
      priorityScoring: { enabled: boolean; model: string | null };
    }>;
    getLifeOpsCalendarFeed(
      options?: GetLifeOpsCalendarFeedRequest,
    ): Promise<LifeOpsCalendarFeed>;
    getLifeOpsCalendars(
      options?: ListLifeOpsCalendarsRequest,
    ): Promise<{ calendars: LifeOpsCalendarSummary[] }>;
    setLifeOpsCalendarIncluded(
      data: SetLifeOpsCalendarIncludedRequest,
    ): Promise<{ calendar: LifeOpsCalendarSummary }>;
    getLifeOpsGmailTriage(
      options?: GetLifeOpsGmailTriageRequest,
    ): Promise<LifeOpsGmailTriageFeed>;
    getLifeOpsGmailSearch(
      options: GetLifeOpsGmailSearchRequest,
    ): Promise<LifeOpsGmailSearchFeed>;
    getLifeOpsGmailNeedsResponse(
      options?: GetLifeOpsGmailTriageRequest,
    ): Promise<LifeOpsGmailNeedsResponseFeed>;
    getLifeOpsGmailRecommendations(
      options?: GetLifeOpsGmailRecommendationsRequest,
    ): Promise<LifeOpsGmailRecommendationsFeed>;
    getLifeOpsGmailUnresponded(
      options?: GetLifeOpsGmailUnrespondedRequest,
    ): Promise<LifeOpsGmailUnrespondedFeed>;
    manageLifeOpsGmailMessages(
      data: ManageLifeOpsGmailMessagesRequest,
    ): Promise<LifeOpsGmailManageResult>;
    getGoogleLifeOpsConnectorStatus(
      mode?: LifeOpsConnectorMode,
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus>;
    getGoogleLifeOpsConnectorAccounts(
      mode?: LifeOpsConnectorMode,
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus[]>;
  }
}

function appendOptionalParam(
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value === null || value === undefined) {
    return;
  }
  params.set(key, String(value));
}

function buildQuery(params: URLSearchParams): string {
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

ElizaClient.prototype.getLifeOpsAppState = async function (this: ElizaClient) {
  return this.fetch("/api/lifeops/app-state");
};

ElizaClient.prototype.updateLifeOpsAppState = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/app-state", {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.getLifeOpsCalendarFeed = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", options.mode);
  appendOptionalParam(params, "side", options.side);
  appendOptionalParam(params, "calendarId", options.calendarId);
  appendOptionalParam(
    params,
    "includeHiddenCalendars",
    options.includeHiddenCalendars,
  );
  appendOptionalParam(params, "timeMin", options.timeMin);
  appendOptionalParam(params, "timeMax", options.timeMax);
  appendOptionalParam(params, "timeZone", options.timeZone);
  appendOptionalParam(params, "forceSync", options.forceSync);
  return this.fetch(`/api/lifeops/calendar/feed${buildQuery(params)}`);
};

ElizaClient.prototype.getLifeOpsCalendars = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", options.mode);
  appendOptionalParam(params, "side", options.side);
  appendOptionalParam(params, "grantId", options.grantId);
  return this.fetch(`/api/lifeops/calendar/calendars${buildQuery(params)}`);
};

ElizaClient.prototype.setLifeOpsCalendarIncluded = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch(
    `/api/lifeops/calendar/calendars/${encodeURIComponent(data.calendarId)}/include`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.getLifeOpsGmailTriage = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", options.mode);
  appendOptionalParam(params, "side", options.side);
  appendOptionalParam(params, "grantId", options.grantId);
  appendOptionalParam(params, "forceSync", options.forceSync);
  appendOptionalParam(params, "maxResults", options.maxResults);
  return this.fetch(`/api/lifeops/gmail/triage${buildQuery(params)}`);
};

ElizaClient.prototype.getLifeOpsGmailSearch = async function (
  this: ElizaClient,
  options,
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", options.mode);
  appendOptionalParam(params, "side", options.side);
  appendOptionalParam(params, "grantId", options.grantId);
  appendOptionalParam(params, "forceSync", options.forceSync);
  appendOptionalParam(params, "maxResults", options.maxResults);
  appendOptionalParam(params, "query", options.query);
  appendOptionalParam(params, "replyNeededOnly", options.replyNeededOnly);
  appendOptionalParam(params, "includeSpamTrash", options.includeSpamTrash);
  return this.fetch(`/api/lifeops/gmail/search${buildQuery(params)}`);
};

ElizaClient.prototype.getLifeOpsGmailNeedsResponse = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", options.mode);
  appendOptionalParam(params, "side", options.side);
  appendOptionalParam(params, "grantId", options.grantId);
  appendOptionalParam(params, "forceSync", options.forceSync);
  appendOptionalParam(params, "maxResults", options.maxResults);
  return this.fetch(`/api/lifeops/gmail/needs-response${buildQuery(params)}`);
};

ElizaClient.prototype.getLifeOpsGmailRecommendations = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", options.mode);
  appendOptionalParam(params, "side", options.side);
  appendOptionalParam(params, "grantId", options.grantId);
  appendOptionalParam(params, "forceSync", options.forceSync);
  appendOptionalParam(params, "maxResults", options.maxResults);
  appendOptionalParam(params, "query", options.query);
  appendOptionalParam(params, "replyNeededOnly", options.replyNeededOnly);
  appendOptionalParam(params, "includeSpamTrash", options.includeSpamTrash);
  return this.fetch(`/api/lifeops/gmail/recommendations${buildQuery(params)}`);
};

ElizaClient.prototype.getLifeOpsGmailUnresponded = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", options.mode);
  appendOptionalParam(params, "side", options.side);
  appendOptionalParam(params, "grantId", options.grantId);
  appendOptionalParam(params, "maxResults", options.maxResults);
  appendOptionalParam(params, "olderThanDays", options.olderThanDays);
  return this.fetch(`/api/lifeops/gmail/unresponded${buildQuery(params)}`);
};

ElizaClient.prototype.manageLifeOpsGmailMessages = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/manage", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.getGoogleLifeOpsConnectorStatus = async function (
  this: ElizaClient,
  mode,
  side,
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", mode);
  appendOptionalParam(params, "side", side);
  return this.fetch(
    `/api/lifeops/connectors/google/status${buildQuery(params)}`,
  );
};

ElizaClient.prototype.getGoogleLifeOpsConnectorAccounts = async function (
  this: ElizaClient,
  mode,
  side,
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", mode);
  appendOptionalParam(params, "side", side);
  return this.fetch(
    `/api/lifeops/connectors/google/accounts${buildQuery(params)}`,
  );
};
