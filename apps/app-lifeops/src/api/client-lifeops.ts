/**
 * LifeOps API methods on ElizaClient.
 *
 * Uses TypeScript declaration merging to augment the `ElizaClient` class in
 * `@elizaos/app-core/api/client-base` with LifeOps-specific methods.
 *
 * Side-effect import — include once at startup to register the methods:
 *
 *   import "@elizaos/app-lifeops/api/client-lifeops";
 *
 * The `@elizaos/app-lifeops/widgets` entry point imports this transitively.
 */

import type {
  CaptureLifeOpsActivitySignalRequest,
  CompleteLifeOpsBrowserSessionRequest,
  CompleteLifeOpsOccurrenceRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserCompanionAutoPairRequest,
  CreateLifeOpsBrowserCompanionPairingRequest,
  CreateLifeOpsBrowserSessionRequest,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  CreateLifeOpsGoalRequest,
  DisconnectLifeOpsGoogleConnectorRequest,
  DisconnectLifeOpsMessagingConnectorRequest,
  GetLifeOpsIMessageMessagesRequest,
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailTriageRequest,
  LifeOpsActivitySignal,
  LifeOpsBrowserCompanionPackageStatus,
  LifeOpsBrowserCompanionAutoPairResponse,
  LifeOpsBrowserCompanionPairingResponse,
  LifeOpsBrowserCompanionStatus,
  LifeOpsBrowserKind,
  LifeOpsBrowserPageContext,
  LifeOpsBrowserSession,
  LifeOpsBrowserSettings,
  LifeOpsBrowserTabSummary,
  LifeOpsCalendarFeed,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsDefinitionRecord,
  LifeOpsDiscordConnectorStatus,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailTriageFeed,
  LifeOpsGoalRecord,
  LifeOpsGoalReview,
  LifeOpsGoogleConnectorStatus,
  LifeOpsIMessageChat,
  LifeOpsIMessageConnectorStatus,
  LifeOpsIMessageMessage,
  LifeOpsNextCalendarEventContext,
  LifeOpsOccurrenceActionResult,
  LifeOpsOccurrenceExplanation,
  LifeOpsOverview,
  LifeOpsReminderInspection,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalPairingStatus,
  LifeOpsTelegramConnectorStatus,
  SelectLifeOpsGoogleConnectorPreferenceRequest,
  SendLifeOpsGmailReplyRequest,
  SendLifeOpsIMessageRequest,
  SnoozeLifeOpsOccurrenceRequest,
  StartLifeOpsDiscordConnectorRequest,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
  StartLifeOpsSignalPairingRequest,
  StartLifeOpsSignalPairingResponse,
  StartLifeOpsTelegramAuthRequest,
  StartLifeOpsTelegramAuthResponse,
  SubmitLifeOpsTelegramAuthRequest,
  VerifyLifeOpsTelegramConnectorRequest,
  VerifyLifeOpsTelegramConnectorResponse,
  SyncLifeOpsBrowserStateRequest,
  UpdateLifeOpsBrowserSettingsRequest,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGoalRequest,
} from "@elizaos/shared/contracts/lifeops";
import { ElizaClient } from "@elizaos/app-core/api/client-base";

declare module "@elizaos/app-core/api/client-base" {
  interface ElizaClient {
    getLifeOpsAppState(): Promise<{ enabled: boolean }>;
    updateLifeOpsAppState(data: {
      enabled: boolean;
    }): Promise<{ enabled: boolean }>;
    getLifeOpsOverview(): Promise<LifeOpsOverview>;
    getLifeOpsBrowserSettings(): Promise<{ settings: LifeOpsBrowserSettings }>;
    updateLifeOpsBrowserSettings(
      data: UpdateLifeOpsBrowserSettingsRequest,
    ): Promise<{ settings: LifeOpsBrowserSettings }>;
    listLifeOpsBrowserCompanions(): Promise<{
      companions: LifeOpsBrowserCompanionStatus[];
    }>;
    getLifeOpsBrowserPackageStatus(): Promise<{
      status: LifeOpsBrowserCompanionPackageStatus;
    }>;
    autoPairLifeOpsBrowserCompanion(
      data: CreateLifeOpsBrowserCompanionAutoPairRequest,
    ): Promise<LifeOpsBrowserCompanionAutoPairResponse>;
    createLifeOpsBrowserCompanionPairing(
      data: CreateLifeOpsBrowserCompanionPairingRequest,
    ): Promise<LifeOpsBrowserCompanionPairingResponse>;
    buildLifeOpsBrowserCompanionPackage(browser: LifeOpsBrowserKind): Promise<{
      status: LifeOpsBrowserCompanionPackageStatus;
    }>;
    downloadLifeOpsBrowserCompanionPackage(
      browser: LifeOpsBrowserKind,
    ): Promise<{
      blob: Blob;
      filename: string;
    }>;
    listLifeOpsBrowserTabs(): Promise<{ tabs: LifeOpsBrowserTabSummary[] }>;
    getLifeOpsBrowserCurrentPage(): Promise<{
      page: LifeOpsBrowserPageContext | null;
    }>;
    syncLifeOpsBrowserState(data: SyncLifeOpsBrowserStateRequest): Promise<{
      companion: LifeOpsBrowserCompanionStatus;
      tabs: LifeOpsBrowserTabSummary[];
      currentPage: LifeOpsBrowserPageContext | null;
    }>;
    listLifeOpsBrowserSessions(): Promise<{
      sessions: LifeOpsBrowserSession[];
    }>;
    getLifeOpsBrowserSession(
      sessionId: string,
    ): Promise<{ session: LifeOpsBrowserSession }>;
    createLifeOpsBrowserSession(
      data: CreateLifeOpsBrowserSessionRequest,
    ): Promise<{ session: LifeOpsBrowserSession }>;
    confirmLifeOpsBrowserSession(
      sessionId: string,
      data: ConfirmLifeOpsBrowserSessionRequest,
    ): Promise<{ session: LifeOpsBrowserSession }>;
    completeLifeOpsBrowserSession(
      sessionId: string,
      data: CompleteLifeOpsBrowserSessionRequest,
    ): Promise<{ session: LifeOpsBrowserSession }>;
    captureLifeOpsActivitySignal(
      data: CaptureLifeOpsActivitySignalRequest,
    ): Promise<{ signal: LifeOpsActivitySignal }>;
    getLifeOpsCalendarFeed(
      options?: GetLifeOpsCalendarFeedRequest,
    ): Promise<LifeOpsCalendarFeed>;
    getLifeOpsGmailTriage(
      options?: GetLifeOpsGmailTriageRequest,
    ): Promise<LifeOpsGmailTriageFeed>;
    getLifeOpsNextCalendarEventContext(
      options?: GetLifeOpsCalendarFeedRequest,
    ): Promise<LifeOpsNextCalendarEventContext>;
    createLifeOpsCalendarEvent(
      data: CreateLifeOpsCalendarEventRequest,
    ): Promise<{ event: LifeOpsCalendarFeed["events"][number] }>;
    createLifeOpsGmailReplyDraft(
      data: CreateLifeOpsGmailReplyDraftRequest,
    ): Promise<{ draft: LifeOpsGmailReplyDraft }>;
    sendLifeOpsGmailReply(
      data: SendLifeOpsGmailReplyRequest,
    ): Promise<{ ok: true }>;
    listLifeOpsDefinitions(): Promise<{
      definitions: LifeOpsDefinitionRecord[];
    }>;
    getLifeOpsDefinition(
      definitionId: string,
    ): Promise<LifeOpsDefinitionRecord>;
    createLifeOpsDefinition(
      data: CreateLifeOpsDefinitionRequest,
    ): Promise<LifeOpsDefinitionRecord>;
    updateLifeOpsDefinition(
      definitionId: string,
      data: UpdateLifeOpsDefinitionRequest,
    ): Promise<LifeOpsDefinitionRecord>;
    listLifeOpsGoals(): Promise<{ goals: LifeOpsGoalRecord[] }>;
    getLifeOpsGoal(goalId: string): Promise<LifeOpsGoalRecord>;
    reviewLifeOpsGoal(goalId: string): Promise<LifeOpsGoalReview>;
    createLifeOpsGoal(
      data: CreateLifeOpsGoalRequest,
    ): Promise<LifeOpsGoalRecord>;
    updateLifeOpsGoal(
      goalId: string,
      data: UpdateLifeOpsGoalRequest,
    ): Promise<LifeOpsGoalRecord>;
    completeLifeOpsOccurrence(
      occurrenceId: string,
      data?: CompleteLifeOpsOccurrenceRequest,
    ): Promise<LifeOpsOccurrenceActionResult>;
    skipLifeOpsOccurrence(
      occurrenceId: string,
    ): Promise<LifeOpsOccurrenceActionResult>;
    snoozeLifeOpsOccurrence(
      occurrenceId: string,
      data: SnoozeLifeOpsOccurrenceRequest,
    ): Promise<LifeOpsOccurrenceActionResult>;
    getLifeOpsOccurrenceExplanation(
      occurrenceId: string,
    ): Promise<LifeOpsOccurrenceExplanation>;
    inspectLifeOpsReminder(
      ownerType: "occurrence" | "calendar_event",
      ownerId: string,
    ): Promise<LifeOpsReminderInspection>;
    getGoogleLifeOpsConnectorStatus(
      mode?: LifeOpsConnectorMode,
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus>;
    selectGoogleLifeOpsConnectorMode(
      data: SelectLifeOpsGoogleConnectorPreferenceRequest,
    ): Promise<LifeOpsGoogleConnectorStatus>;
    startGoogleLifeOpsConnector(
      data?: StartLifeOpsGoogleConnectorRequest,
    ): Promise<StartLifeOpsGoogleConnectorResponse>;
    disconnectGoogleLifeOpsConnector(
      data?: DisconnectLifeOpsGoogleConnectorRequest,
    ): Promise<LifeOpsGoogleConnectorStatus>;
    getGoogleLifeOpsConnectorAccounts(
      mode?: LifeOpsConnectorMode,
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsGoogleConnectorStatus[]>;

    // --- iMessage connector ---
    getIMessageConnectorStatus(): Promise<LifeOpsIMessageConnectorStatus>;
    listLifeOpsIMessageChats(): Promise<{
      chats: LifeOpsIMessageChat[];
      count: number;
    }>;
    getLifeOpsIMessageMessages(
      options?: GetLifeOpsIMessageMessagesRequest,
    ): Promise<{
      messages: LifeOpsIMessageMessage[];
      count: number;
    }>;
    sendLifeOpsIMessage(
      data: SendLifeOpsIMessageRequest,
    ): Promise<{ ok: true; messageId?: string }>;

    // --- Signal connector ---
    getSignalConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsSignalConnectorStatus>;
    startLifeOpsSignalPairing(
      data?: StartLifeOpsSignalPairingRequest,
    ): Promise<StartLifeOpsSignalPairingResponse>;
    getSignalPairingStatus(
      sessionId: string,
    ): Promise<LifeOpsSignalPairingStatus>;
    stopLifeOpsSignalPairing(sessionId: string): Promise<void>;
    disconnectSignalConnector(
      data?: DisconnectLifeOpsMessagingConnectorRequest,
    ): Promise<LifeOpsSignalConnectorStatus>;

    // --- Discord connector ---
    getDiscordConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsDiscordConnectorStatus>;
    startDiscordConnector(
      data?: StartLifeOpsDiscordConnectorRequest,
    ): Promise<LifeOpsDiscordConnectorStatus>;
    disconnectDiscordConnector(
      data?: DisconnectLifeOpsMessagingConnectorRequest,
    ): Promise<LifeOpsDiscordConnectorStatus>;

    // --- Telegram connector ---
    getTelegramConnectorStatus(
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsTelegramConnectorStatus>;
    startTelegramAuth(
      data: StartLifeOpsTelegramAuthRequest,
    ): Promise<StartLifeOpsTelegramAuthResponse>;
    submitTelegramAuth(
      data: SubmitLifeOpsTelegramAuthRequest,
    ): Promise<StartLifeOpsTelegramAuthResponse>;
    cancelTelegramAuth(
      data?: DisconnectLifeOpsMessagingConnectorRequest,
    ): Promise<void>;
    disconnectTelegramConnector(
      data?: DisconnectLifeOpsMessagingConnectorRequest,
    ): Promise<LifeOpsTelegramConnectorStatus>;
    verifyTelegramConnector(
      data?: VerifyLifeOpsTelegramConnectorRequest,
    ): Promise<VerifyLifeOpsTelegramConnectorResponse>;
  }
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

ElizaClient.prototype.getLifeOpsOverview = async function (this: ElizaClient) {
  return this.fetch("/api/lifeops/overview");
};

ElizaClient.prototype.getLifeOpsBrowserSettings = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/browser/settings");
};

ElizaClient.prototype.updateLifeOpsBrowserSettings = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/browser/settings", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.listLifeOpsBrowserCompanions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/browser/companions");
};

ElizaClient.prototype.getLifeOpsBrowserPackageStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/browser/packages");
};

ElizaClient.prototype.autoPairLifeOpsBrowserCompanion = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/browser/companions/auto-pair", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.createLifeOpsBrowserCompanionPairing = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/browser/companions/pair", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.buildLifeOpsBrowserCompanionPackage = async function (
  this: ElizaClient,
  browser,
) {
  return this.fetch(
    `/api/lifeops/browser/packages/${encodeURIComponent(browser)}/build`,
    {
      method: "POST",
    },
  );
};

ElizaClient.prototype.downloadLifeOpsBrowserCompanionPackage = async function (
  this: ElizaClient,
  browser,
) {
  const response = await this.rawRequest(
    `/api/lifeops/browser/packages/${encodeURIComponent(browser)}/download`,
    {
      method: "GET",
    },
  );
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filenameMatch = disposition.match(/filename="([^"]+)"/i);
  return {
    blob: await response.blob(),
    filename:
      filenameMatch?.[1] ??
      `lifeops-browser-${browser === "safari" ? "safari" : "chrome"}.zip`,
  };
};

ElizaClient.prototype.listLifeOpsBrowserTabs = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/browser/tabs");
};

ElizaClient.prototype.getLifeOpsBrowserCurrentPage = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/browser/current-page");
};

ElizaClient.prototype.syncLifeOpsBrowserState = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/browser/sync", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.listLifeOpsBrowserSessions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/browser/sessions");
};

ElizaClient.prototype.getLifeOpsBrowserSession = async function (
  this: ElizaClient,
  sessionId,
) {
  return this.fetch(
    `/api/lifeops/browser/sessions/${encodeURIComponent(sessionId)}`,
  );
};

ElizaClient.prototype.createLifeOpsBrowserSession = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/browser/sessions", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.confirmLifeOpsBrowserSession = async function (
  this: ElizaClient,
  sessionId,
  data,
) {
  return this.fetch(
    `/api/lifeops/browser/sessions/${encodeURIComponent(sessionId)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.completeLifeOpsBrowserSession = async function (
  this: ElizaClient,
  sessionId,
  data,
) {
  return this.fetch(
    `/api/lifeops/browser/sessions/${encodeURIComponent(sessionId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.captureLifeOpsActivitySignal = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/activity-signals", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.getLifeOpsCalendarFeed = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.calendarId) {
    params.set("calendarId", options.calendarId);
  }
  if (options.timeMin) {
    params.set("timeMin", options.timeMin);
  }
  if (options.timeMax) {
    params.set("timeMax", options.timeMax);
  }
  if (options.timeZone) {
    params.set("timeZone", options.timeZone);
  }
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  const query = params.toString();
  return this.fetch(`/api/lifeops/calendar/feed${query ? `?${query}` : ""}`);
};

ElizaClient.prototype.getLifeOpsGmailTriage = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  const query = params.toString();
  return this.fetch(`/api/lifeops/gmail/triage${query ? `?${query}` : ""}`);
};

ElizaClient.prototype.getLifeOpsNextCalendarEventContext = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.calendarId) {
    params.set("calendarId", options.calendarId);
  }
  if (options.timeMin) {
    params.set("timeMin", options.timeMin);
  }
  if (options.timeMax) {
    params.set("timeMax", options.timeMax);
  }
  if (options.timeZone) {
    params.set("timeZone", options.timeZone);
  }
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/calendar/next-context${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.createLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/calendar/events", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.createLifeOpsGmailReplyDraft = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/reply-drafts", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.sendLifeOpsGmailReply = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/reply-send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.listLifeOpsDefinitions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/definitions");
};

ElizaClient.prototype.getLifeOpsDefinition = async function (
  this: ElizaClient,
  definitionId,
) {
  return this.fetch(
    `/api/lifeops/definitions/${encodeURIComponent(definitionId)}`,
  );
};

ElizaClient.prototype.createLifeOpsDefinition = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/definitions", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.updateLifeOpsDefinition = async function (
  this: ElizaClient,
  definitionId,
  data,
) {
  return this.fetch(
    `/api/lifeops/definitions/${encodeURIComponent(definitionId)}`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.listLifeOpsGoals = async function (this: ElizaClient) {
  return this.fetch("/api/lifeops/goals");
};

ElizaClient.prototype.getLifeOpsGoal = async function (
  this: ElizaClient,
  goalId,
) {
  return this.fetch(`/api/lifeops/goals/${encodeURIComponent(goalId)}`);
};

ElizaClient.prototype.reviewLifeOpsGoal = async function (
  this: ElizaClient,
  goalId,
) {
  return this.fetch(`/api/lifeops/goals/${encodeURIComponent(goalId)}/review`);
};

ElizaClient.prototype.createLifeOpsGoal = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/goals", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.updateLifeOpsGoal = async function (
  this: ElizaClient,
  goalId,
  data,
) {
  return this.fetch(`/api/lifeops/goals/${encodeURIComponent(goalId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.completeLifeOpsOccurrence = async function (
  this: ElizaClient,
  occurrenceId,
  data = {},
) {
  return this.fetch(
    `/api/lifeops/occurrences/${encodeURIComponent(occurrenceId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.skipLifeOpsOccurrence = async function (
  this: ElizaClient,
  occurrenceId,
) {
  return this.fetch(
    `/api/lifeops/occurrences/${encodeURIComponent(occurrenceId)}/skip`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
};

ElizaClient.prototype.snoozeLifeOpsOccurrence = async function (
  this: ElizaClient,
  occurrenceId,
  data,
) {
  return this.fetch(
    `/api/lifeops/occurrences/${encodeURIComponent(occurrenceId)}/snooze`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.getLifeOpsOccurrenceExplanation = async function (
  this: ElizaClient,
  occurrenceId,
) {
  return this.fetch(
    `/api/lifeops/occurrences/${encodeURIComponent(occurrenceId)}/explanation`,
  );
};

ElizaClient.prototype.inspectLifeOpsReminder = async function (
  this: ElizaClient,
  ownerType,
  ownerId,
) {
  const params = new URLSearchParams({
    ownerType,
    ownerId,
  });
  return this.fetch(`/api/lifeops/reminders/inspection?${params.toString()}`);
};

ElizaClient.prototype.getGoogleLifeOpsConnectorStatus = async function (
  this: ElizaClient,
  mode,
  side,
) {
  const params = new URLSearchParams();
  if (mode) {
    params.set("mode", mode);
  }
  if (side) {
    params.set("side", side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/google/status${query}`);
};

ElizaClient.prototype.selectGoogleLifeOpsConnectorMode = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/google/preference", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.startGoogleLifeOpsConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/google/start", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.disconnectGoogleLifeOpsConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/google/disconnect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.getGoogleLifeOpsConnectorAccounts = async function (
  this: ElizaClient,
  mode,
  side,
) {
  const params = new URLSearchParams();
  if (mode) {
    params.set("mode", mode);
  }
  if (side) {
    params.set("side", side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/google/accounts${query}`);
};

// ---------------------------------------------------------------------------
// iMessage connector
// ---------------------------------------------------------------------------

ElizaClient.prototype.getIMessageConnectorStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/connectors/imessage/status");
};

ElizaClient.prototype.listLifeOpsIMessageChats = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/connectors/imessage/chats");
};

ElizaClient.prototype.getLifeOpsIMessageMessages = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.chatId) {
    params.set("chatId", options.chatId);
  }
  if (options.since) {
    params.set("since", options.since);
  }
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/imessage/messages${query}`);
};

ElizaClient.prototype.sendLifeOpsIMessage = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/imessage/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// ---------------------------------------------------------------------------
// Signal connector
// ---------------------------------------------------------------------------

ElizaClient.prototype.getSignalConnectorStatus = async function (
  this: ElizaClient,
  side,
) {
  const params = new URLSearchParams();
  if (side) {
    params.set("side", side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/signal/status${query}`);
};

ElizaClient.prototype.startLifeOpsSignalPairing = async function (
  this: ElizaClient,
  data = {},
): Promise<StartLifeOpsSignalPairingResponse> {
  return this.fetch<StartLifeOpsSignalPairingResponse>(
    "/api/lifeops/connectors/signal/pair",
    {
    method: "POST",
    body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.getSignalPairingStatus = async function (
  this: ElizaClient,
  sessionId,
) {
  const params = new URLSearchParams({ sessionId });
  return this.fetch(
    `/api/lifeops/connectors/signal/pairing-status?${params.toString()}`,
  );
};

ElizaClient.prototype.stopLifeOpsSignalPairing = async function (
  this: ElizaClient,
  sessionId,
): Promise<void> {
  return this.fetch<void>("/api/lifeops/connectors/signal/stop", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
};

ElizaClient.prototype.disconnectSignalConnector = async function (
  this: ElizaClient,
  data = { provider: "signal" },
) {
  return this.fetch("/api/lifeops/connectors/signal/disconnect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// ---------------------------------------------------------------------------
// Discord connector
// ---------------------------------------------------------------------------

ElizaClient.prototype.getDiscordConnectorStatus = async function (
  this: ElizaClient,
  side,
) {
  const params = new URLSearchParams();
  if (side) {
    params.set("side", side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/discord/status${query}`);
};

ElizaClient.prototype.startDiscordConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/discord/connect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.disconnectDiscordConnector = async function (
  this: ElizaClient,
  data = { provider: "discord" },
) {
  return this.fetch("/api/lifeops/connectors/discord/disconnect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// ---------------------------------------------------------------------------
// Telegram connector
// ---------------------------------------------------------------------------

ElizaClient.prototype.getTelegramConnectorStatus = async function (
  this: ElizaClient,
  side,
) {
  const params = new URLSearchParams();
  if (side) {
    params.set("side", side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/telegram/status${query}`);
};

ElizaClient.prototype.startTelegramAuth = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/telegram/start", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.submitTelegramAuth = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/telegram/submit", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.cancelTelegramAuth = async function (
  this: ElizaClient,
  data = { provider: "telegram" },
) {
  return this.fetch("/api/lifeops/connectors/telegram/cancel", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.disconnectTelegramConnector = async function (
  this: ElizaClient,
  data = { provider: "telegram" },
) {
  return this.fetch("/api/lifeops/connectors/telegram/disconnect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.verifyTelegramConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/telegram/verify", {
    method: "POST",
    body: JSON.stringify(data),
  });
};
