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

import { ElizaClient } from "@elizaos/app-core/api/client-base";
import type {
  BrowserBridgeCompanionAutoPairResponse,
  BrowserBridgeCompanionPackageStatus,
  BrowserBridgeCompanionPairingResponse,
  BrowserBridgeCompanionStatus,
  BrowserBridgeKind,
  BrowserBridgePackagePathTarget,
  BrowserBridgePageContext,
  BrowserBridgeSettings,
  BrowserBridgeTabSummary,
  CreateBrowserBridgeCompanionAutoPairRequest,
  CreateBrowserBridgeCompanionPairingRequest,
  OpenBrowserBridgeCompanionManagerResponse,
  OpenBrowserBridgeCompanionPackagePathResponse,
  SyncBrowserBridgeStateRequest,
  UpdateBrowserBridgeSettingsRequest,
} from "@elizaos/plugin-browser-bridge/contracts";
import type {
  CaptureLifeOpsActivitySignalRequest,
  CaptureLifeOpsManualOverrideRequest,
  CompleteLifeOpsBrowserSessionRequest,
  CompleteLifeOpsOccurrenceRequest,
  ConfirmLifeOpsBrowserSessionRequest,
  CreateLifeOpsBrowserSessionRequest,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  CreateLifeOpsGoalRequest,
  DisconnectLifeOpsGoogleConnectorRequest,
  DisconnectLifeOpsMessagingConnectorRequest,
  DisconnectLifeOpsXConnectorRequest,
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailRecommendationsRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailSpamReviewRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  GetLifeOpsIMessageMessagesRequest,
  GetLifeOpsInboxRequest,
  IngestLifeOpsGmailEventRequest,
  LifeOpsActivitySignal,
  LifeOpsBrowserSession,
  LifeOpsCalendarEventMutationResult,
  LifeOpsCalendarEventUpdate,
  LifeOpsCalendarFeed,
  LifeOpsCapabilitiesStatus,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsDefinitionRecord,
  LifeOpsDiscordConnectorStatus,
  LifeOpsGmailEventIngestResult,
  LifeOpsGmailManageResult,
  LifeOpsGmailNeedsResponseFeed,
  LifeOpsGmailRecommendationsFeed,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailSearchFeed,
  LifeOpsGmailSpamReviewFeed,
  LifeOpsGmailSpamReviewItem,
  LifeOpsGmailTriageFeed,
  LifeOpsGmailUnrespondedFeed,
  LifeOpsGoalRecord,
  LifeOpsGoalReview,
  LifeOpsGoogleConnectorStatus,
  LifeOpsIMessageChat,
  LifeOpsIMessageConnectorStatus,
  LifeOpsIMessageMessage,
  LifeOpsManualOverrideResult,
  LifeOpsNextCalendarEventContext,
  LifeOpsOccurrenceActionResult,
  LifeOpsOccurrenceExplanation,
  LifeOpsOverview,
  LifeOpsReminderInspection,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalPairingStatus,
  LifeOpsTelegramConnectorStatus,
  LifeOpsInbox,
  LifeOpsXConnectorStatus,
  ManageLifeOpsGmailMessagesRequest,
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
  StartLifeOpsXConnectorRequest,
  StartLifeOpsXConnectorResponse,
  SubmitLifeOpsTelegramAuthRequest,
  UpdateLifeOpsBrowserSessionProgressRequest,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGmailSpamReviewItemRequest,
  UpdateLifeOpsGoalRequest,
  VerifyLifeOpsTelegramConnectorRequest,
  VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared/contracts/lifeops";
import type { FullDiskAccessProbeResult } from "../lifeops/fda-probe.js";
import type {
  LifeOpsScheduleInspection,
  LifeOpsScheduleSummary,
} from "../lifeops/schedule-insight.js";
import type { GetLifeOpsScheduleMergedStateResponse } from "../lifeops/schedule-sync-contracts.js";

type LifeOpsScheduleInspectionResponse = LifeOpsScheduleInspection;

import type { RoutineSeedTemplate } from "../lifeops/seed-routines.js";

type LifeOpsSeedRoutinesResponse = {
  createdIds: string[];
};

type LifeOpsSeedTemplatesResponse = {
  needsSeeding: boolean;
  availableTemplates: RoutineSeedTemplate[];
};

type LifeOpsXConnectorRequest = {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  capabilities: LifeOpsXConnectorStatus["grantedCapabilities"];
  grantedScopes?: string[];
  identity?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type LifeOpsXPostRequest = {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  text: string;
  confirmPost?: boolean;
};

type LifeOpsScheduleMergedStateRequest = {
  timezone?: string | null;
  scope?: "local" | "cloud" | "effective";
  refresh?: boolean;
};

export type LifeOpsScreenTimeSource = "app" | "website";

export type LifeOpsScreenTimeSummaryRequest = {
  since: string;
  until: string;
  source?: LifeOpsScreenTimeSource;
  topN?: number;
};

export type LifeOpsScreenTimeSummaryItem = {
  source: LifeOpsScreenTimeSource;
  identifier: string;
  displayName: string;
  totalSeconds: number;
};

export type LifeOpsScreenTimeSummary = {
  items: LifeOpsScreenTimeSummaryItem[];
  totalSeconds: number;
};

export type LifeOpsHabitCategory =
  | "browser"
  | "communication"
  | "social"
  | "system"
  | "video"
  | "work"
  | "other";

export type LifeOpsHabitDevice =
  | "browser"
  | "computer"
  | "phone"
  | "tablet"
  | "unknown";

export type LifeOpsScreenTimeBucket = {
  key: string;
  label: string;
  totalSeconds: number;
};

export type LifeOpsScreenTimeBreakdownItem = LifeOpsScreenTimeSummaryItem & {
  sessionCount: number;
  category: LifeOpsHabitCategory;
  device: LifeOpsHabitDevice;
  service: string | null;
  serviceLabel: string | null;
  browser: string | null;
};

export type LifeOpsScreenTimeBreakdown = {
  items: LifeOpsScreenTimeBreakdownItem[];
  totalSeconds: number;
  bySource: LifeOpsScreenTimeBucket[];
  byCategory: LifeOpsScreenTimeBucket[];
  byDevice: LifeOpsScreenTimeBucket[];
  byService: LifeOpsScreenTimeBucket[];
  byBrowser: LifeOpsScreenTimeBucket[];
  fetchedAt: string;
};

export type LifeOpsSocialHabitSummary = {
  since: string;
  until: string;
  totalSeconds: number;
  services: LifeOpsScreenTimeBucket[];
  devices: LifeOpsScreenTimeBucket[];
  surfaces: LifeOpsScreenTimeBucket[];
  browsers: LifeOpsScreenTimeBucket[];
  sessions: LifeOpsScreenTimeBreakdownItem[];
  messages: {
    channels: Array<{
      channel: "x_dm";
      label: string;
      inbound: number;
      outbound: number;
      opened: number;
      replied: number;
    }>;
    inbound: number;
    outbound: number;
    opened: number;
    replied: number;
  };
  dataSources: Array<{
    id: string;
    label: string;
    state: "live" | "partial" | "unwired";
  }>;
  fetchedAt: string;
};

declare module "@elizaos/app-core/api/client-base" {
  interface ElizaClient {
    getLifeOpsAppState(): Promise<{ enabled: boolean }>;
    updateLifeOpsAppState(data: {
      enabled: boolean;
    }): Promise<{ enabled: boolean }>;
    getLifeOpsOverview(): Promise<LifeOpsOverview>;
    getLifeOpsPaymentsDashboard(
      data?: { windowDays?: number | null },
    ): Promise<import("../lifeops/payment-types.js").LifeOpsPaymentsDashboard>;
    listLifeOpsPaymentSources(): Promise<{
      sources: import("../lifeops/payment-types.js").LifeOpsPaymentSource[];
    }>;
    addLifeOpsPaymentSource(
      data: import("../lifeops/payment-types.js").AddPaymentSourceRequest,
    ): Promise<{
      source: import("../lifeops/payment-types.js").LifeOpsPaymentSource;
    }>;
    deleteLifeOpsPaymentSource(sourceId: string): Promise<{ ok: true }>;
    importLifeOpsPaymentCsv(
      data: import("../lifeops/payment-types.js").ImportTransactionsCsvRequest,
    ): Promise<import("../lifeops/payment-types.js").ImportTransactionsCsvResult>;
    listLifeOpsPaymentTransactions(data?: {
      sourceId?: string | null;
      limit?: number | null;
      merchantContains?: string | null;
      onlyDebits?: boolean | null;
    }): Promise<{
      transactions: import("../lifeops/payment-types.js").LifeOpsPaymentTransaction[];
    }>;
    listLifeOpsRecurringCharges(data?: {
      sourceId?: string | null;
      sinceDays?: number | null;
    }): Promise<{
      charges: import("../lifeops/payment-types.js").LifeOpsRecurringCharge[];
    }>;
    scanLifeOpsEmailSubscriptions(): Promise<
      import("../lifeops/email-unsubscribe-types.js").EmailSubscriptionScanResult
    >;
    unsubscribeLifeOpsEmailSender(data: {
      senderEmail: string;
      blockAfter?: boolean;
      trashExisting?: boolean;
      confirmed: boolean;
    }): Promise<
      import("../lifeops/email-unsubscribe-types.js").EmailUnsubscribeResult
    >;
    getLifeOpsCapabilitiesStatus(): Promise<LifeOpsCapabilitiesStatus>;
    getLifeOpsScheduleMergedState(
      data?: LifeOpsScheduleMergedStateRequest,
    ): Promise<GetLifeOpsScheduleMergedStateResponse>;
    getLifeOpsScreenTimeSummary(
      data: LifeOpsScreenTimeSummaryRequest,
    ): Promise<LifeOpsScreenTimeSummary>;
    getLifeOpsScreenTimeBreakdown(
      data: LifeOpsScreenTimeSummaryRequest,
    ): Promise<LifeOpsScreenTimeBreakdown>;
    getLifeOpsSocialHabitSummary(
      data: Omit<LifeOpsScreenTimeSummaryRequest, "source">,
    ): Promise<LifeOpsSocialHabitSummary>;
    getLifeOpsSeedTemplates(): Promise<LifeOpsSeedTemplatesResponse>;
    seedLifeOpsRoutines(data: {
      keys: string[];
      timezone?: string;
    }): Promise<LifeOpsSeedRoutinesResponse>;
    getBrowserBridgeSettings(): Promise<{ settings: BrowserBridgeSettings }>;
    updateBrowserBridgeSettings(
      data: UpdateBrowserBridgeSettingsRequest,
    ): Promise<{ settings: BrowserBridgeSettings }>;
    listBrowserBridgeCompanions(): Promise<{
      companions: BrowserBridgeCompanionStatus[];
    }>;
    getBrowserBridgePackageStatus(): Promise<{
      status: BrowserBridgeCompanionPackageStatus;
    }>;
    autoPairBrowserBridgeCompanion(
      data: CreateBrowserBridgeCompanionAutoPairRequest,
    ): Promise<BrowserBridgeCompanionAutoPairResponse>;
    createBrowserBridgeCompanionPairing(
      data: CreateBrowserBridgeCompanionPairingRequest,
    ): Promise<BrowserBridgeCompanionPairingResponse>;
    buildBrowserBridgeCompanionPackage(browser: BrowserBridgeKind): Promise<{
      status: BrowserBridgeCompanionPackageStatus;
    }>;
    openBrowserBridgeCompanionPackagePath(data: {
      target: BrowserBridgePackagePathTarget;
      revealOnly?: boolean;
    }): Promise<OpenBrowserBridgeCompanionPackagePathResponse>;
    openBrowserBridgeCompanionManager(
      browser: BrowserBridgeKind,
    ): Promise<OpenBrowserBridgeCompanionManagerResponse>;
    downloadBrowserBridgeCompanionPackage(browser: BrowserBridgeKind): Promise<{
      blob: Blob;
      filename: string;
    }>;
    listBrowserBridgeTabs(): Promise<{ tabs: BrowserBridgeTabSummary[] }>;
    getBrowserBridgeCurrentPage(): Promise<{
      page: BrowserBridgePageContext | null;
    }>;
    syncBrowserBridgeState(data: SyncBrowserBridgeStateRequest): Promise<{
      companion: BrowserBridgeCompanionStatus;
      tabs: BrowserBridgeTabSummary[];
      currentPage: BrowserBridgePageContext | null;
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
    updateLifeOpsBrowserSessionProgress(
      sessionId: string,
      data: UpdateLifeOpsBrowserSessionProgressRequest,
    ): Promise<{ session: LifeOpsBrowserSession }>;
    completeLifeOpsBrowserSession(
      sessionId: string,
      data: CompleteLifeOpsBrowserSessionRequest,
    ): Promise<{ session: LifeOpsBrowserSession }>;
    captureLifeOpsActivitySignal(
      data: CaptureLifeOpsActivitySignalRequest,
    ): Promise<{ signal: LifeOpsActivitySignal }>;
    captureLifeOpsManualOverride(
      data: CaptureLifeOpsManualOverrideRequest,
    ): Promise<LifeOpsManualOverrideResult>;
    getLifeOpsScheduleInspection(
      timezone: string,
    ): Promise<LifeOpsScheduleInspectionResponse>;
    getLifeOpsScheduleSummary(
      timezone: string,
    ): Promise<LifeOpsScheduleSummary>;
    getLifeOpsFullDiskAccessStatus(): Promise<FullDiskAccessProbeResult>;
    getLifeOpsCalendarFeed(
      options?: GetLifeOpsCalendarFeedRequest,
    ): Promise<LifeOpsCalendarFeed>;
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
    getLifeOpsGmailSpamReview(
      options?: GetLifeOpsGmailSpamReviewRequest,
    ): Promise<LifeOpsGmailSpamReviewFeed>;
    updateLifeOpsGmailSpamReviewItem(
      itemId: string,
      data: UpdateLifeOpsGmailSpamReviewItemRequest,
    ): Promise<{ item: LifeOpsGmailSpamReviewItem }>;
    getLifeOpsGmailUnresponded(
      options?: GetLifeOpsGmailUnrespondedRequest,
    ): Promise<LifeOpsGmailUnrespondedFeed>;
    getLifeOpsNextCalendarEventContext(
      options?: GetLifeOpsCalendarFeedRequest,
    ): Promise<LifeOpsNextCalendarEventContext>;
    createLifeOpsCalendarEvent(
      data: CreateLifeOpsCalendarEventRequest,
    ): Promise<{ event: LifeOpsCalendarFeed["events"][number] }>;
    updateLifeOpsCalendarEvent(
      eventId: string,
      patch: LifeOpsCalendarEventUpdate,
    ): Promise<LifeOpsCalendarEventMutationResult>;
    deleteLifeOpsCalendarEvent(
      eventId: string,
      options?: Pick<
        LifeOpsCalendarEventUpdate,
        "calendarId" | "grantId" | "side"
      >,
    ): Promise<{ deleted: true }>;
    getLifeOpsInbox(
      options?: GetLifeOpsInboxRequest,
    ): Promise<LifeOpsInbox>;
    createLifeOpsGmailReplyDraft(
      data: CreateLifeOpsGmailReplyDraftRequest,
    ): Promise<{ draft: LifeOpsGmailReplyDraft }>;
    sendLifeOpsGmailReply(
      data: SendLifeOpsGmailReplyRequest,
    ): Promise<{ ok: true }>;
    manageLifeOpsGmailMessages(
      data: ManageLifeOpsGmailMessagesRequest,
    ): Promise<LifeOpsGmailManageResult>;
    ingestLifeOpsGmailEvent(
      data: IngestLifeOpsGmailEventRequest,
    ): Promise<LifeOpsGmailEventIngestResult>;
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
    getXLifeOpsConnectorStatus(
      mode?: LifeOpsConnectorMode,
      side?: LifeOpsConnectorSide,
    ): Promise<LifeOpsXConnectorStatus>;
    startXLifeOpsConnector(
      data?: StartLifeOpsXConnectorRequest,
    ): Promise<StartLifeOpsXConnectorResponse>;
    disconnectXLifeOpsConnector(
      data?: DisconnectLifeOpsXConnectorRequest,
    ): Promise<LifeOpsXConnectorStatus>;
    upsertXLifeOpsConnector(
      data: LifeOpsXConnectorRequest,
    ): Promise<LifeOpsXConnectorStatus>;
    createXLifeOpsPost(data: LifeOpsXPostRequest): Promise<{
      ok: boolean;
      status: number | null;
      postId?: string;
      error?: string;
      category:
        | "success"
        | "auth"
        | "rate_limit"
        | "network"
        | "invalid"
        | "unknown";
    }>;

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
    getLifeOpsSignalPairingStatus(
      sessionId: string,
    ): Promise<LifeOpsSignalPairingStatus>;
    stopLifeOpsSignalPairing(
      sessionId: string,
    ): Promise<LifeOpsSignalPairingStatus>;
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
    ): Promise<LifeOpsTelegramConnectorStatus>;
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

ElizaClient.prototype.getLifeOpsPaymentsDashboard = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.windowDays !== null && data.windowDays !== undefined) {
    params.set("windowDays", String(data.windowDays));
  }
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/payments/dashboard${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.listLifeOpsPaymentSources = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/payments/sources");
};

ElizaClient.prototype.addLifeOpsPaymentSource = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/payments/sources", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.deleteLifeOpsPaymentSource = async function (
  this: ElizaClient,
  sourceId: string,
) {
  return this.fetch(
    `/api/lifeops/payments/sources/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" },
  );
};

ElizaClient.prototype.importLifeOpsPaymentCsv = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/payments/import-csv", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.listLifeOpsPaymentTransactions = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.sourceId) params.set("sourceId", data.sourceId);
  if (data.limit !== null && data.limit !== undefined) {
    params.set("limit", String(data.limit));
  }
  if (data.merchantContains) params.set("merchantContains", data.merchantContains);
  if (data.onlyDebits) params.set("onlyDebits", "true");
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/payments/transactions${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.listLifeOpsRecurringCharges = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.sourceId) params.set("sourceId", data.sourceId);
  if (data.sinceDays !== null && data.sinceDays !== undefined) {
    params.set("sinceDays", String(data.sinceDays));
  }
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/payments/recurring${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.scanLifeOpsEmailSubscriptions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/email-unsubscribe/scan", { method: "POST" });
};

ElizaClient.prototype.unsubscribeLifeOpsEmailSender = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/email-unsubscribe/unsubscribe", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.getLifeOpsCapabilitiesStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/capabilities");
};

ElizaClient.prototype.getLifeOpsScheduleMergedState = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.timezone) {
    params.set("timezone", data.timezone);
  }
  if (data.scope) {
    params.set("scope", data.scope);
  }
  if (data.refresh !== undefined) {
    params.set("refresh", String(data.refresh));
  }
  const query = params.toString();
  return this.fetch<GetLifeOpsScheduleMergedStateResponse>(
    `/api/lifeops/schedule/merged-state${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.getLifeOpsScreenTimeSummary = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("since", data.since);
  params.set("until", data.until);
  if (data.source) {
    params.set("source", data.source);
  }
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  return this.fetch<LifeOpsScreenTimeSummary>(
    `/api/lifeops/screen-time/summary?${params.toString()}`,
  );
};

ElizaClient.prototype.getLifeOpsScreenTimeBreakdown = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("since", data.since);
  params.set("until", data.until);
  if (data.source) {
    params.set("source", data.source);
  }
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  return this.fetch<LifeOpsScreenTimeBreakdown>(
    `/api/lifeops/screen-time/breakdown?${params.toString()}`,
  );
};

ElizaClient.prototype.getLifeOpsSocialHabitSummary = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("since", data.since);
  params.set("until", data.until);
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  return this.fetch<LifeOpsSocialHabitSummary>(
    `/api/lifeops/social/summary?${params.toString()}`,
  );
};

ElizaClient.prototype.getLifeOpsSeedTemplates = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/seed-templates");
};

ElizaClient.prototype.seedLifeOpsRoutines = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch<LifeOpsSeedRoutinesResponse>("/api/lifeops/seed", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.getBrowserBridgeSettings = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/settings");
};

ElizaClient.prototype.updateBrowserBridgeSettings = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/settings", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.listBrowserBridgeCompanions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/companions");
};

ElizaClient.prototype.getBrowserBridgePackageStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/packages");
};

ElizaClient.prototype.autoPairBrowserBridgeCompanion = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/companions/auto-pair", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.createBrowserBridgeCompanionPairing = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/companions/pair", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.buildBrowserBridgeCompanionPackage = async function (
  this: ElizaClient,
  browser,
) {
  return this.fetch(
    `/api/browser-bridge/packages/${encodeURIComponent(browser)}/build`,
    {
      method: "POST",
    },
  );
};

ElizaClient.prototype.openBrowserBridgeCompanionPackagePath = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/packages/open-path", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.openBrowserBridgeCompanionManager = async function (
  this: ElizaClient,
  browser,
) {
  return this.fetch(
    `/api/browser-bridge/packages/${encodeURIComponent(browser)}/open-manager`,
    {
      method: "POST",
    },
  );
};

ElizaClient.prototype.downloadBrowserBridgeCompanionPackage = async function (
  this: ElizaClient,
  browser,
) {
  const response = await this.rawRequest(
    `/api/browser-bridge/packages/${encodeURIComponent(browser)}/download`,
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
      `browser-bridge-${browser === "safari" ? "safari" : "chrome"}.zip`,
  };
};

ElizaClient.prototype.listBrowserBridgeTabs = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/tabs");
};

ElizaClient.prototype.getBrowserBridgeCurrentPage = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/current-page");
};

ElizaClient.prototype.syncBrowserBridgeState = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/sync", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.listLifeOpsBrowserSessions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/sessions");
};

ElizaClient.prototype.getLifeOpsBrowserSession = async function (
  this: ElizaClient,
  sessionId,
) {
  return this.fetch(
    `/api/browser-bridge/sessions/${encodeURIComponent(sessionId)}`,
  );
};

ElizaClient.prototype.createLifeOpsBrowserSession = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/sessions", {
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
    `/api/browser-bridge/sessions/${encodeURIComponent(sessionId)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.updateLifeOpsBrowserSessionProgress = async function (
  this: ElizaClient,
  sessionId,
  data,
) {
  return this.fetch(
    `/api/browser-bridge/sessions/${encodeURIComponent(sessionId)}/progress`,
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
    `/api/browser-bridge/sessions/${encodeURIComponent(sessionId)}/complete`,
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

ElizaClient.prototype.captureLifeOpsManualOverride = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/manual-override", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.getLifeOpsScheduleInspection = async function (
  this: ElizaClient,
  timezone,
) {
  const params = new URLSearchParams();
  params.set("timezone", timezone);
  return this.fetch(`/api/lifeops/schedule/inspection?${params.toString()}`);
};

ElizaClient.prototype.getLifeOpsScheduleSummary = async function (
  this: ElizaClient,
  timezone,
) {
  const params = new URLSearchParams();
  params.set("timezone", timezone);
  return this.fetch(`/api/lifeops/schedule/summary?${params.toString()}`);
};

ElizaClient.prototype.getLifeOpsFullDiskAccessStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/permissions/full-disk-access");
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
  if (options.grantId) {
    params.set("grantId", options.grantId);
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

ElizaClient.prototype.getLifeOpsGmailSearch = async function (
  this: ElizaClient,
  options,
) {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set("mode", options.mode);
  }
  if (options.side) {
    params.set("side", options.side);
  }
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  if (options.replyNeededOnly !== undefined) {
    params.set("replyNeededOnly", String(options.replyNeededOnly));
  }
  if (options.includeSpamTrash !== undefined) {
    params.set("includeSpamTrash", String(options.includeSpamTrash));
  }
  params.set("query", options.query);
  const query = params.toString();
  return this.fetch(`/api/lifeops/gmail/search${query ? `?${query}` : ""}`);
};

ElizaClient.prototype.getLifeOpsGmailNeedsResponse = async function (
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
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/gmail/needs-response${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.getLifeOpsGmailRecommendations = async function (
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
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  if (options.query) {
    params.set("query", options.query);
  }
  if (options.replyNeededOnly !== undefined) {
    params.set("replyNeededOnly", String(options.replyNeededOnly));
  }
  if (options.includeSpamTrash !== undefined) {
    params.set("includeSpamTrash", String(options.includeSpamTrash));
  }
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/gmail/recommendations${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.getLifeOpsGmailSpamReview = async function (
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
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.status) {
    params.set("status", options.status);
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/gmail/spam-review${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.updateLifeOpsGmailSpamReviewItem = async function (
  this: ElizaClient,
  itemId,
  data,
) {
  return this.fetch(
    `/api/lifeops/gmail/spam-review/${encodeURIComponent(itemId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(data),
    },
  );
};

ElizaClient.prototype.getLifeOpsGmailUnresponded = async function (
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
  if (options.grantId) {
    params.set("grantId", options.grantId);
  }
  if (options.maxResults !== undefined) {
    params.set("maxResults", String(options.maxResults));
  }
  if (options.olderThanDays !== undefined) {
    params.set("olderThanDays", String(options.olderThanDays));
  }
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/gmail/unresponded${query ? `?${query}` : ""}`,
  );
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

ElizaClient.prototype.updateLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  eventId,
  patch,
) {
  return this.fetch(
    `/api/lifeops/calendar/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
};

ElizaClient.prototype.deleteLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  eventId,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.calendarId) params.set("calendarId", options.calendarId);
  if (options.grantId) params.set("grantId", options.grantId);
  if (options.side) params.set("side", options.side);
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/calendar/events/${encodeURIComponent(eventId)}${query ? `?${query}` : ""}`,
    {
      method: "DELETE",
    },
  );
};

ElizaClient.prototype.getLifeOpsInbox = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.channels && options.channels.length > 0) {
    params.set("channels", options.channels.join(","));
  }
  const query = params.toString();
  return this.fetch(`/api/lifeops/inbox${query ? `?${query}` : ""}`);
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

ElizaClient.prototype.manageLifeOpsGmailMessages = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/manage", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.ingestLifeOpsGmailEvent = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/events/ingest", {
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

ElizaClient.prototype.getXLifeOpsConnectorStatus = async function (
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
  return this.fetch(`/api/lifeops/connectors/x/status${query}`);
};

ElizaClient.prototype.startXLifeOpsConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/x/start", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.disconnectXLifeOpsConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/x/disconnect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.upsertXLifeOpsConnector = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/x", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.createXLifeOpsPost = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/x/posts", {
    method: "POST",
    body: JSON.stringify(data),
  });
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

ElizaClient.prototype.getLifeOpsSignalPairingStatus = async function (
  this: ElizaClient,
  sessionId: string,
): Promise<LifeOpsSignalPairingStatus> {
  const params = new URLSearchParams({ sessionId });
  return this.fetch<LifeOpsSignalPairingStatus>(
    `/api/lifeops/connectors/signal/pairing-status?${params.toString()}`,
  );
};

ElizaClient.prototype.stopLifeOpsSignalPairing = async function (
  this: ElizaClient,
  sessionId,
): Promise<LifeOpsSignalPairingStatus> {
  return this.fetch<LifeOpsSignalPairingStatus>(
    "/api/lifeops/connectors/signal/stop",
    {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    },
  );
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
  const params = new URLSearchParams();
  if (data.side) {
    params.set("side", data.side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/telegram/cancel${query}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
};

ElizaClient.prototype.disconnectTelegramConnector = async function (
  this: ElizaClient,
  data = { provider: "telegram" },
) {
  const params = new URLSearchParams();
  if (data.side) {
    params.set("side", data.side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/telegram/disconnect${query}`, {
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
