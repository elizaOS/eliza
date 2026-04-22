import type {
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  LifeOpsCalendarFeed,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGmailManageResult,
  LifeOpsGmailTriageFeed,
  LifeOpsGmailUnrespondedFeed,
  LifeOpsGoogleConnectorStatus,
  ManageLifeOpsGmailMessagesRequest,
} from "@elizaos/app-lifeops/contracts";
import { ElizaClient } from "./client-base";

declare module "./client-base" {
  interface ElizaClient {
    getLifeOpsAppState(): Promise<{ enabled: boolean }>;
    updateLifeOpsAppState(data: {
      enabled: boolean;
    }): Promise<{ enabled: boolean }>;
    getLifeOpsCalendarFeed(
      options?: GetLifeOpsCalendarFeedRequest,
    ): Promise<LifeOpsCalendarFeed>;
    getLifeOpsGmailTriage(
      options?: GetLifeOpsGmailTriageRequest,
    ): Promise<LifeOpsGmailTriageFeed>;
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
  appendOptionalParam(params, "timeMin", options.timeMin);
  appendOptionalParam(params, "timeMax", options.timeMax);
  appendOptionalParam(params, "timeZone", options.timeZone);
  appendOptionalParam(params, "forceSync", options.forceSync);
  return this.fetch(`/api/lifeops/calendar/feed${buildQuery(params)}`);
};

ElizaClient.prototype.getLifeOpsGmailTriage = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  appendOptionalParam(params, "mode", options.mode);
  appendOptionalParam(params, "side", options.side);
  appendOptionalParam(params, "forceSync", options.forceSync);
  appendOptionalParam(params, "maxResults", options.maxResults);
  return this.fetch(`/api/lifeops/gmail/triage${buildQuery(params)}`);
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
