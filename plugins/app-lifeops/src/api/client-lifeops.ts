/**
 * LifeOps API methods on ElizaClient.
 *
 * Uses TypeScript declaration merging to augment the `ElizaClient` class in
 * `@elizaos/ui` with LifeOps-specific methods.
 *
 * Include once at startup to register the methods.
 *
 * The `@elizaos/app-lifeops/widgets` entry point imports this transitively.
 */

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
} from "@elizaos/plugin-browser";
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
  DisconnectLifeOpsHealthConnectorRequest,
  DisconnectLifeOpsMessagingConnectorRequest,
  DisconnectLifeOpsXConnectorRequest,
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailRecommendationsRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailSpamReviewRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  GetLifeOpsHealthSummaryRequest,
  GetLifeOpsIMessageMessagesRequest,
  GetLifeOpsInboxRequest,
  GetLifeOpsSignalMessagesResponse,
  IngestLifeOpsGmailEventRequest,
  LifeOpsActivitySignal,
  LifeOpsBrowserSession,
  LifeOpsCalendarEventMutationResult,
  LifeOpsCalendarEventUpdate,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
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
  LifeOpsHealthConnectorProvider,
  LifeOpsHealthConnectorStatus,
  LifeOpsHealthSummaryResponse,
  LifeOpsIMessageChat,
  LifeOpsIMessageConnectorStatus,
  LifeOpsIMessageMessage,
  LifeOpsInbox,
  LifeOpsManualOverrideResult,
  LifeOpsNextCalendarEventContext,
  LifeOpsOccurrenceActionResult,
  LifeOpsOccurrenceExplanation,
  LifeOpsOverview,
  LifeOpsPersonalBaselineResponse,
  LifeOpsReminderInspection,
  LifeOpsScreenTimeBreakdown,
  LifeOpsScreenTimeHistoryResponse,
  LifeOpsScreenTimeRangeKey,
  LifeOpsScreenTimeSummary,
  LifeOpsScreenTimeSummaryRequest,
  LifeOpsSignalConnectorStatus,
  LifeOpsSignalPairingStatus,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
  LifeOpsSocialHabitSummary,
  LifeOpsTelegramConnectorStatus,
  LifeOpsWhatsAppConnectorStatus,
  LifeOpsXConnectorStatus,
  ListLifeOpsCalendarsRequest,
  ManageLifeOpsGmailMessagesRequest,
  SendLifeOpsDiscordMessageRequest,
  SendLifeOpsDiscordMessageResponse,
  SendLifeOpsGmailReplyRequest,
  SendLifeOpsIMessageRequest,
  SendLifeOpsSignalMessageRequest,
  SendLifeOpsSignalMessageResponse,
  SendLifeOpsWhatsAppMessageRequest,
  SetLifeOpsCalendarIncludedRequest,
  SnoozeLifeOpsOccurrenceRequest,
  StartLifeOpsDiscordConnectorRequest,
  StartLifeOpsHealthConnectorRequest,
  StartLifeOpsHealthConnectorResponse,
  StartLifeOpsSignalPairingRequest,
  StartLifeOpsSignalPairingResponse,
  StartLifeOpsTelegramAuthRequest,
  StartLifeOpsTelegramAuthResponse,
  StartLifeOpsXConnectorRequest,
  StartLifeOpsXConnectorResponse,
  SubmitLifeOpsTelegramAuthRequest,
  SyncLifeOpsHealthConnectorRequest,
  UpdateLifeOpsBrowserSessionProgressRequest,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGmailSpamReviewItemRequest,
  UpdateLifeOpsGoalRequest,
  VerifyLifeOpsDiscordConnectorRequest,
  VerifyLifeOpsDiscordConnectorResponse,
  VerifyLifeOpsTelegramConnectorRequest,
  VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
// Direct source-module import to break the barrel cycle:
// app-core/api/client.ts imports this file (LifeOps extension) as a
// side-effect before re-exporting `ElizaClient` from its barrel, so a
// barrel import here would resolve to `undefined` at module-init time.
import { ElizaClient } from "@elizaos/ui";
import type { FullDiskAccessProbeResult } from "../lifeops/fda-probe.js";
import type {
  LifeOpsScheduleInspection,
  LifeOpsScheduleSummary,
} from "../lifeops/schedule-insight.js";
import type { GetLifeOpsScheduleMergedStateResponse } from "../lifeops/schedule-sync-contracts.js";

type LifeOpsScheduleInspectionResponse = LifeOpsScheduleInspection;

// Wave-2 W2-A removed `RoutineSeedTemplate`, `LifeOpsSeedTemplatesResponse`,
// and `LifeOpsSeedRoutinesResponse`. The legacy seed-routines surface is
// retired in favour of the FIRST_RUN customize path.

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

export type {
  LifeOpsHabitCategory,
  LifeOpsHabitDevice,
  LifeOpsScreenTimeBreakdown,
  LifeOpsScreenTimeBreakdownItem,
  LifeOpsScreenTimeBucket,
  LifeOpsScreenTimeHistoryResponse,
  LifeOpsScreenTimeRangeKey,
  LifeOpsScreenTimeSource,
  LifeOpsScreenTimeSummary,
  LifeOpsScreenTimeSummaryItem,
  LifeOpsScreenTimeSummaryRequest,
  LifeOpsSocialHabitDataSource,
  LifeOpsSocialHabitSummary,
} from "@elizaos/shared";

export type LifeOpsPriorityScoringStateDto = {
  enabled: boolean;
  model: string | null;
};

export type LifeOpsAppStateDto = {
  enabled: boolean;
  priorityScoring: LifeOpsPriorityScoringStateDto;
};

type RawRequestClient = {
  rawRequest(path: string, init?: RequestInit): Promise<Response>;
};

interface LifeOpsElizaClientMethods {
  getLifeOpsAppState(): Promise<LifeOpsAppStateDto>;
  updateLifeOpsAppState(data: {
    enabled: boolean;
    priorityScoring?: LifeOpsPriorityScoringStateDto | null;
  }): Promise<LifeOpsAppStateDto>;
  getLifeOpsOverview(): Promise<LifeOpsOverview>;
  getLifeOpsPaymentsDashboard(data?: {
    windowDays?: number | null;
  }): Promise<import("../lifeops/payment-types.js").LifeOpsPaymentsDashboard>;
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
  listLifeOpsUpcomingBills(): Promise<{
    bills: import("../lifeops/payment-types.js").LifeOpsUpcomingBill[];
  }>;
  getLifeOpsSmartFeatureSettings(): Promise<{
    emailClassifierEnabled: boolean;
    emailClassifierModel: string;
    billsAutoExtract: boolean;
  }>;
  updateLifeOpsSmartFeatureSettings(data: {
    emailClassifierEnabled?: boolean;
    emailClassifierModel?: string | null;
    billsAutoExtract?: boolean;
  }): Promise<{ ok: true }>;
  markLifeOpsBillPaid(data: {
    billId: string;
    paidAt?: string | null;
  }): Promise<{ ok: true }>;
  snoozeLifeOpsBill(data: {
    billId: string;
    days?: number;
  }): Promise<{ ok: true; dueDate: string }>;
  scanLifeOpsEmailSubscriptions(): Promise<
    import("../lifeops/email-unsubscribe-types.js").EmailSubscriptionScanResult
  >;
  lookupLifeOpsSubscriptionPlaybook(merchant: string): Promise<{
    playbook: {
      key: string;
      serviceName: string;
      managementUrl: string;
      executorPreference: "user_browser" | "agent_browser" | "desktop_native";
    } | null;
  }>;
  listLifeOpsSubscriptionPlaybooks(): Promise<{
    playbooks: Array<{
      key: string;
      serviceName: string;
      aliases: string[];
      managementUrl: string;
      executorPreference: "user_browser" | "agent_browser" | "desktop_native";
    }>;
  }>;
  cancelLifeOpsSubscription(data: {
    serviceName?: string | null;
    serviceSlug?: string | null;
    candidateId?: string | null;
    executor?: "user_browser" | "agent_browser" | "desktop_native" | null;
    confirmed?: boolean;
  }): Promise<unknown>;
  createLifeOpsPlaidLinkToken(): Promise<{
    linkToken: string;
    expiration: string;
    environment: string;
  }>;
  completeLifeOpsPlaidLink(data: {
    publicToken: string;
    label?: string | null;
  }): Promise<{
    source: import("../lifeops/payment-types.js").LifeOpsPaymentSource;
  }>;
  syncLifeOpsPlaidTransactions(data: { sourceId: string }): Promise<{
    inserted: number;
    skipped: number;
    nextCursor: string;
  }>;
  createLifeOpsPaypalAuthorizeUrl(data: { state: string }): Promise<{
    url: string;
    scope: string;
    environment: "live" | "sandbox";
  }>;
  completeLifeOpsPaypalLink(data: {
    code: string;
    label?: string | null;
  }): Promise<{
    source: import("../lifeops/payment-types.js").LifeOpsPaymentSource;
    capability: { hasReporting: boolean; hasIdentity: boolean };
  }>;
  syncLifeOpsPaypalTransactions(data: {
    sourceId: string;
    windowDays?: number | null;
  }): Promise<{
    inserted: number;
    skipped: number;
    fallback: "csv_export" | null;
  }>;
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
  getLifeOpsScreenTimeHistory(data: {
    range: LifeOpsScreenTimeRangeKey;
    topN?: number;
    socialTopN?: number;
  }): Promise<LifeOpsScreenTimeHistoryResponse>;
  getLifeOpsSocialHabitSummary(
    data: Omit<LifeOpsScreenTimeSummaryRequest, "source" | "identifier">,
  ): Promise<LifeOpsSocialHabitSummary>;
  getLifeOpsSleepHistory(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepHistoryResponse>;
  getLifeOpsSleepRegularity(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepRegularityResponse>;
  getLifeOpsPersonalBaseline(opts?: {
    windowDays?: number;
  }): Promise<LifeOpsPersonalBaselineResponse>;
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
  getLifeOpsScheduleSummary(timezone: string): Promise<LifeOpsScheduleSummary>;
  getLifeOpsFullDiskAccessStatus(): Promise<FullDiskAccessProbeResult>;
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
  getLifeOpsInbox(options?: GetLifeOpsInboxRequest): Promise<LifeOpsInbox>;
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
  getLifeOpsDefinition(definitionId: string): Promise<LifeOpsDefinitionRecord>;
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
  createLifeOpsGoal(data: CreateLifeOpsGoalRequest): Promise<LifeOpsGoalRecord>;
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
  getHealthLifeOpsConnectorStatuses(
    mode?: LifeOpsConnectorMode,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus[]>;
  getHealthLifeOpsConnectorStatus(
    provider: LifeOpsHealthConnectorProvider,
    mode?: LifeOpsConnectorMode,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsHealthConnectorStatus>;
  startHealthLifeOpsConnector(
    provider: LifeOpsHealthConnectorProvider,
    data?: Omit<StartLifeOpsHealthConnectorRequest, "provider">,
  ): Promise<StartLifeOpsHealthConnectorResponse>;
  disconnectHealthLifeOpsConnector(
    provider: LifeOpsHealthConnectorProvider,
    data?: Omit<DisconnectLifeOpsHealthConnectorRequest, "provider">,
  ): Promise<LifeOpsHealthConnectorStatus>;
  syncLifeOpsHealth(
    data?: SyncLifeOpsHealthConnectorRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;
  getLifeOpsHealthSummary(
    data?: GetLifeOpsHealthSummaryRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;
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
    data?: DisconnectLifeOpsMessagingConnectorRequest,
  ): Promise<LifeOpsSignalPairingStatus>;
  disconnectSignalConnector(
    data?: DisconnectLifeOpsMessagingConnectorRequest,
  ): Promise<LifeOpsSignalConnectorStatus>;
  getSignalConnectorMessages(options?: {
    limit?: number;
  }): Promise<GetLifeOpsSignalMessagesResponse>;
  sendSignalConnectorMessage(
    data: SendLifeOpsSignalMessageRequest,
  ): Promise<SendLifeOpsSignalMessageResponse>;

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
  sendDiscordConnectorMessage(
    data: SendLifeOpsDiscordMessageRequest,
  ): Promise<SendLifeOpsDiscordMessageResponse>;
  verifyDiscordConnector(
    data?: VerifyLifeOpsDiscordConnectorRequest,
  ): Promise<VerifyLifeOpsDiscordConnectorResponse>;

  // --- WhatsApp connector ---
  getWhatsAppConnectorStatus(): Promise<LifeOpsWhatsAppConnectorStatus>;
  sendWhatsAppConnectorMessage(
    data: SendLifeOpsWhatsAppMessageRequest,
  ): Promise<{ ok: true; messageId: string }>;
  getWhatsAppConnectorMessages(options?: { limit?: number }): Promise<{
    count: number;
    messages: Array<{
      id: string;
      from: string;
      channelId: string;
      timestamp: string;
      type: "text" | "image" | "audio" | "document" | "unknown";
      text?: string;
    }>;
  }>;

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

declare module "@elizaos/ui" {
  interface ElizaClient extends LifeOpsElizaClientMethods {}
}

const lifeOpsClientPrototype = ElizaClient.prototype as ElizaClient &
  LifeOpsElizaClientMethods;

lifeOpsClientPrototype.getLifeOpsAppState = async function (this: ElizaClient) {
  return this.fetch<LifeOpsAppStateDto>("/api/lifeops/app-state");
};

lifeOpsClientPrototype.updateLifeOpsAppState = async function (
  this: ElizaClient,
  data: {
    enabled: boolean;
    priorityScoring?: LifeOpsPriorityScoringStateDto | null;
  },
) {
  return this.fetch<LifeOpsAppStateDto>("/api/lifeops/app-state", {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getLifeOpsOverview = async function (this: ElizaClient) {
  return this.fetch("/api/lifeops/overview");
};

lifeOpsClientPrototype.getLifeOpsPaymentsDashboard = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.windowDays !== null && data.windowDays !== undefined) {
    params.set("windowDays", String(data.windowDays));
  }
  const query = params.toString();
  return this.fetch(`/api/lifeops/money/dashboard${query ? `?${query}` : ""}`);
};

lifeOpsClientPrototype.listLifeOpsPaymentSources = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/money/sources");
};

lifeOpsClientPrototype.addLifeOpsPaymentSource = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/sources", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.deleteLifeOpsPaymentSource = async function (
  this: ElizaClient,
  sourceId: string,
) {
  return this.fetch(
    `/api/lifeops/money/sources/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" },
  );
};

lifeOpsClientPrototype.importLifeOpsPaymentCsv = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/import-csv", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.listLifeOpsPaymentTransactions = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.sourceId) params.set("sourceId", data.sourceId);
  if (data.limit !== null && data.limit !== undefined) {
    params.set("limit", String(data.limit));
  }
  if (data.merchantContains)
    params.set("merchantContains", data.merchantContains);
  if (data.onlyDebits) params.set("onlyDebits", "true");
  const query = params.toString();
  return this.fetch(
    `/api/lifeops/money/transactions${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.listLifeOpsRecurringCharges = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.sourceId) params.set("sourceId", data.sourceId);
  if (data.sinceDays !== null && data.sinceDays !== undefined) {
    params.set("sinceDays", String(data.sinceDays));
  }
  const query = params.toString();
  return this.fetch(`/api/lifeops/money/recurring${query ? `?${query}` : ""}`);
};

lifeOpsClientPrototype.scanLifeOpsEmailSubscriptions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/email-unsubscribe/scan", { method: "POST" });
};

lifeOpsClientPrototype.listLifeOpsUpcomingBills = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/money/bills");
};

lifeOpsClientPrototype.markLifeOpsBillPaid = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/bills/mark-paid", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.snoozeLifeOpsBill = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/bills/snooze", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getLifeOpsSmartFeatureSettings = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/smart-features/settings");
};

lifeOpsClientPrototype.updateLifeOpsSmartFeatureSettings = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/smart-features/settings", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.lookupLifeOpsSubscriptionPlaybook = async function (
  this: ElizaClient,
  merchant: string,
) {
  const params = new URLSearchParams({ merchant });
  return this.fetch(
    `/api/lifeops/subscriptions/playbook-lookup?${params.toString()}`,
  );
};

lifeOpsClientPrototype.listLifeOpsSubscriptionPlaybooks = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/subscriptions/playbooks");
};

lifeOpsClientPrototype.cancelLifeOpsSubscription = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/subscriptions/cancel", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.createLifeOpsPlaidLinkToken = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/money/plaid/link-token", { method: "POST" });
};

lifeOpsClientPrototype.completeLifeOpsPlaidLink = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/plaid/complete", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.syncLifeOpsPlaidTransactions = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/plaid/sync", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.createLifeOpsPaypalAuthorizeUrl = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/paypal/authorize-url", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.completeLifeOpsPaypalLink = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/paypal/complete", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.syncLifeOpsPaypalTransactions = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/money/paypal/sync", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.unsubscribeLifeOpsEmailSender = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/email-unsubscribe/unsubscribe", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getLifeOpsCapabilitiesStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/capabilities");
};

lifeOpsClientPrototype.getLifeOpsScheduleMergedState = async function (
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

lifeOpsClientPrototype.getLifeOpsScreenTimeSummary = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("since", data.since);
  params.set("until", data.until);
  if (data.source) {
    params.set("source", data.source);
  }
  if (data.identifier) {
    params.set("identifier", data.identifier);
  }
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  return this.fetch<LifeOpsScreenTimeSummary>(
    `/api/lifeops/screen-time/summary?${params.toString()}`,
  );
};

lifeOpsClientPrototype.getLifeOpsScreenTimeBreakdown = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("since", data.since);
  params.set("until", data.until);
  if (data.source) {
    params.set("source", data.source);
  }
  if (data.identifier) {
    params.set("identifier", data.identifier);
  }
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  return this.fetch<LifeOpsScreenTimeBreakdown>(
    `/api/lifeops/screen-time/breakdown?${params.toString()}`,
  );
};

lifeOpsClientPrototype.getLifeOpsScreenTimeHistory = async function (
  this: ElizaClient,
  data,
) {
  const params = new URLSearchParams();
  params.set("range", data.range);
  if (data.topN !== undefined) {
    params.set("topN", String(data.topN));
  }
  if (data.socialTopN !== undefined) {
    params.set("socialTopN", String(data.socialTopN));
  }
  return this.fetch<LifeOpsScreenTimeHistoryResponse>(
    `/api/lifeops/screen-time/history?${params.toString()}`,
  );
};

lifeOpsClientPrototype.getLifeOpsSocialHabitSummary = async function (
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

lifeOpsClientPrototype.getLifeOpsSleepHistory = async function (
  this: ElizaClient,
  opts,
) {
  const params = new URLSearchParams();
  if (opts?.windowDays !== undefined) {
    params.set("windowDays", String(opts.windowDays));
  }
  if (opts?.includeNaps !== undefined) {
    params.set("includeNaps", String(opts.includeNaps));
  }
  const query = params.toString();
  return this.fetch<LifeOpsSleepHistoryResponse>(
    `/api/lifeops/sleep/history${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsSleepRegularity = async function (
  this: ElizaClient,
  opts,
) {
  const params = new URLSearchParams();
  if (opts?.windowDays !== undefined) {
    params.set("windowDays", String(opts.windowDays));
  }
  if (opts?.includeNaps !== undefined) {
    params.set("includeNaps", String(opts.includeNaps));
  }
  const query = params.toString();
  return this.fetch<LifeOpsSleepRegularityResponse>(
    `/api/lifeops/sleep/regularity${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsPersonalBaseline = async function (
  this: ElizaClient,
  opts,
) {
  const params = new URLSearchParams();
  if (opts?.windowDays !== undefined) {
    params.set("windowDays", String(opts.windowDays));
  }
  const query = params.toString();
  return this.fetch<LifeOpsPersonalBaselineResponse>(
    `/api/lifeops/sleep/baseline${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getBrowserBridgeSettings = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/settings");
};

lifeOpsClientPrototype.updateBrowserBridgeSettings = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/settings", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.listBrowserBridgeCompanions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/companions");
};

lifeOpsClientPrototype.getBrowserBridgePackageStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/packages");
};

lifeOpsClientPrototype.autoPairBrowserBridgeCompanion = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/companions/auto-pair", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.createBrowserBridgeCompanionPairing = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/companions/pair", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.buildBrowserBridgeCompanionPackage = async function (
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

lifeOpsClientPrototype.openBrowserBridgeCompanionPackagePath = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/packages/open-path", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.openBrowserBridgeCompanionManager = async function (
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

lifeOpsClientPrototype.downloadBrowserBridgeCompanionPackage = async function (
  this: ElizaClient,
  browser,
) {
  const response = await (this as ElizaClient & RawRequestClient).rawRequest(
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

lifeOpsClientPrototype.listBrowserBridgeTabs = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/tabs");
};

lifeOpsClientPrototype.getBrowserBridgeCurrentPage = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/current-page");
};

lifeOpsClientPrototype.syncBrowserBridgeState = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/sync", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.listLifeOpsBrowserSessions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/browser-bridge/sessions");
};

lifeOpsClientPrototype.getLifeOpsBrowserSession = async function (
  this: ElizaClient,
  sessionId,
) {
  return this.fetch(
    `/api/browser-bridge/sessions/${encodeURIComponent(sessionId)}`,
  );
};

lifeOpsClientPrototype.createLifeOpsBrowserSession = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/browser-bridge/sessions", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.confirmLifeOpsBrowserSession = async function (
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

lifeOpsClientPrototype.updateLifeOpsBrowserSessionProgress = async function (
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

lifeOpsClientPrototype.completeLifeOpsBrowserSession = async function (
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

lifeOpsClientPrototype.captureLifeOpsActivitySignal = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/activity-signals", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.captureLifeOpsManualOverride = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/manual-override", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getLifeOpsScheduleInspection = async function (
  this: ElizaClient,
  timezone,
) {
  const params = new URLSearchParams();
  params.set("timezone", timezone);
  return this.fetch(`/api/lifeops/schedule/inspection?${params.toString()}`);
};

lifeOpsClientPrototype.getLifeOpsScheduleSummary = async function (
  this: ElizaClient,
  timezone,
) {
  const params = new URLSearchParams();
  params.set("timezone", timezone);
  return this.fetch(`/api/lifeops/schedule/summary?${params.toString()}`);
};

lifeOpsClientPrototype.getLifeOpsFullDiskAccessStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/permissions/full-disk-access");
};

lifeOpsClientPrototype.getLifeOpsCalendarFeed = async function (
  this: ElizaClient,
  options: GetLifeOpsCalendarFeedRequest = {},
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
  if (options.calendarId) {
    params.set("calendarId", options.calendarId);
  }
  if (options.includeHiddenCalendars !== undefined) {
    params.set(
      "includeHiddenCalendars",
      String(options.includeHiddenCalendars),
    );
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
  return this.fetch<LifeOpsCalendarFeed>(
    `/api/lifeops/calendar/feed${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsCalendars = async function (
  this: ElizaClient,
  options: ListLifeOpsCalendarsRequest = {},
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
  const query = params.toString();
  return this.fetch<{ calendars: LifeOpsCalendarSummary[] }>(
    `/api/lifeops/calendar/calendars${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.setLifeOpsCalendarIncluded = async function (
  this: ElizaClient,
  data: SetLifeOpsCalendarIncludedRequest,
) {
  return this.fetch<{ calendar: LifeOpsCalendarSummary }>(
    `/api/lifeops/calendar/calendars/${encodeURIComponent(data.calendarId)}/include`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.getLifeOpsGmailTriage = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailTriageRequest = {},
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
  return this.fetch<LifeOpsGmailTriageFeed>(
    `/api/lifeops/gmail/triage${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsGmailSearch = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailSearchRequest,
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
  return this.fetch<LifeOpsGmailSearchFeed>(
    `/api/lifeops/gmail/search${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsGmailNeedsResponse = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailTriageRequest = {},
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
  return this.fetch<LifeOpsGmailNeedsResponseFeed>(
    `/api/lifeops/gmail/needs-response${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsGmailRecommendations = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailRecommendationsRequest = {},
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
  return this.fetch<LifeOpsGmailRecommendationsFeed>(
    `/api/lifeops/gmail/recommendations${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsGmailSpamReview = async function (
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

lifeOpsClientPrototype.updateLifeOpsGmailSpamReviewItem = async function (
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

lifeOpsClientPrototype.getLifeOpsGmailUnresponded = async function (
  this: ElizaClient,
  options: GetLifeOpsGmailUnrespondedRequest = {},
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
  return this.fetch<LifeOpsGmailUnrespondedFeed>(
    `/api/lifeops/gmail/unresponded${query ? `?${query}` : ""}`,
  );
};

lifeOpsClientPrototype.getLifeOpsNextCalendarEventContext = async function (
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

lifeOpsClientPrototype.createLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/calendar/events", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.updateLifeOpsCalendarEvent = async function (
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

lifeOpsClientPrototype.deleteLifeOpsCalendarEvent = async function (
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

lifeOpsClientPrototype.getLifeOpsInbox = async function (
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
  if (options.groupByThread === true) {
    params.set("groupByThread", "true");
  }
  if (options.chatTypeFilter && options.chatTypeFilter.length > 0) {
    params.set("chatTypeFilter", options.chatTypeFilter.join(","));
  }
  if (options.maxParticipants !== undefined) {
    params.set("maxParticipants", String(options.maxParticipants));
  }
  if (options.gmailAccountId) {
    params.set("gmailAccountId", options.gmailAccountId);
  }
  if (options.missedOnly === true) {
    params.set("missedOnly", "true");
  }
  if (options.sortByPriority === true) {
    params.set("sortByPriority", "true");
  }
  if (options.cacheMode) {
    params.set("cacheMode", options.cacheMode);
  }
  if (options.cacheLimit !== undefined) {
    params.set("cacheLimit", String(options.cacheLimit));
  }
  const query = params.toString();
  return this.fetch(`/api/lifeops/inbox${query ? `?${query}` : ""}`);
};

lifeOpsClientPrototype.createLifeOpsGmailReplyDraft = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/reply-drafts", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.sendLifeOpsGmailReply = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/reply-send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.manageLifeOpsGmailMessages = async function (
  this: ElizaClient,
  data: ManageLifeOpsGmailMessagesRequest,
) {
  return this.fetch<LifeOpsGmailManageResult>("/api/lifeops/gmail/manage", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.ingestLifeOpsGmailEvent = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/gmail/events/ingest", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.listLifeOpsDefinitions = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/definitions");
};

lifeOpsClientPrototype.getLifeOpsDefinition = async function (
  this: ElizaClient,
  definitionId,
) {
  return this.fetch(
    `/api/lifeops/definitions/${encodeURIComponent(definitionId)}`,
  );
};

lifeOpsClientPrototype.createLifeOpsDefinition = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/definitions", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.updateLifeOpsDefinition = async function (
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

lifeOpsClientPrototype.listLifeOpsGoals = async function (this: ElizaClient) {
  return this.fetch("/api/lifeops/goals");
};

lifeOpsClientPrototype.getLifeOpsGoal = async function (
  this: ElizaClient,
  goalId,
) {
  return this.fetch(`/api/lifeops/goals/${encodeURIComponent(goalId)}`);
};

lifeOpsClientPrototype.reviewLifeOpsGoal = async function (
  this: ElizaClient,
  goalId,
) {
  return this.fetch(`/api/lifeops/goals/${encodeURIComponent(goalId)}/review`);
};

lifeOpsClientPrototype.createLifeOpsGoal = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/goals", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.updateLifeOpsGoal = async function (
  this: ElizaClient,
  goalId,
  data,
) {
  return this.fetch(`/api/lifeops/goals/${encodeURIComponent(goalId)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.completeLifeOpsOccurrence = async function (
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

lifeOpsClientPrototype.skipLifeOpsOccurrence = async function (
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

lifeOpsClientPrototype.snoozeLifeOpsOccurrence = async function (
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

lifeOpsClientPrototype.getLifeOpsOccurrenceExplanation = async function (
  this: ElizaClient,
  occurrenceId,
) {
  return this.fetch(
    `/api/lifeops/occurrences/${encodeURIComponent(occurrenceId)}/explanation`,
  );
};

lifeOpsClientPrototype.inspectLifeOpsReminder = async function (
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

lifeOpsClientPrototype.getHealthLifeOpsConnectorStatuses = async function (
  this: ElizaClient,
  mode?: LifeOpsConnectorMode,
  side?: LifeOpsConnectorSide,
) {
  const params = new URLSearchParams();
  if (mode) {
    params.set("mode", mode);
  }
  if (side) {
    params.set("side", side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch<LifeOpsHealthConnectorStatus[]>(
    `/api/lifeops/connectors/health/status${query}`,
  );
};

lifeOpsClientPrototype.getHealthLifeOpsConnectorStatus = async function (
  this: ElizaClient,
  provider,
  mode?: LifeOpsConnectorMode,
  side?: LifeOpsConnectorSide,
) {
  const params = new URLSearchParams();
  if (mode) {
    params.set("mode", mode);
  }
  if (side) {
    params.set("side", side);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch<LifeOpsHealthConnectorStatus>(
    `/api/lifeops/connectors/health/${encodeURIComponent(provider)}/status${query}`,
  );
};

lifeOpsClientPrototype.startHealthLifeOpsConnector = async function (
  this: ElizaClient,
  provider,
  data = {},
) {
  return this.fetch<StartLifeOpsHealthConnectorResponse>(
    `/api/lifeops/connectors/health/${encodeURIComponent(provider)}/start`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.disconnectHealthLifeOpsConnector = async function (
  this: ElizaClient,
  provider,
  data = {},
) {
  return this.fetch<LifeOpsHealthConnectorStatus>(
    `/api/lifeops/connectors/health/${encodeURIComponent(provider)}/disconnect`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.syncLifeOpsHealth = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch<LifeOpsHealthSummaryResponse>("/api/lifeops/health/sync", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getLifeOpsHealthSummary = async function (
  this: ElizaClient,
  data = {},
) {
  const params = new URLSearchParams();
  if (data.provider) params.set("provider", data.provider);
  if (data.mode) params.set("mode", data.mode);
  if (data.side) params.set("side", data.side);
  if (data.days !== undefined) params.set("days", String(data.days));
  if (data.startDate) params.set("startDate", data.startDate);
  if (data.endDate) params.set("endDate", data.endDate);
  if (data.forceSync) params.set("forceSync", "true");
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch<LifeOpsHealthSummaryResponse>(
    `/api/lifeops/health/summary${query}`,
  );
};

lifeOpsClientPrototype.getXLifeOpsConnectorStatus = async function (
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

lifeOpsClientPrototype.startXLifeOpsConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/x/start", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.disconnectXLifeOpsConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/x/disconnect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.upsertXLifeOpsConnector = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/x", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.createXLifeOpsPost = async function (
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

lifeOpsClientPrototype.getIMessageConnectorStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/connectors/imessage/status");
};

lifeOpsClientPrototype.listLifeOpsIMessageChats = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/connectors/imessage/chats");
};

lifeOpsClientPrototype.getLifeOpsIMessageMessages = async function (
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

lifeOpsClientPrototype.sendLifeOpsIMessage = async function (
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

lifeOpsClientPrototype.getSignalConnectorStatus = async function (
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

lifeOpsClientPrototype.startLifeOpsSignalPairing = async function (
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

lifeOpsClientPrototype.getLifeOpsSignalPairingStatus = async function (
  this: ElizaClient,
  sessionId: string,
): Promise<LifeOpsSignalPairingStatus> {
  const params = new URLSearchParams({ sessionId });
  return this.fetch<LifeOpsSignalPairingStatus>(
    `/api/lifeops/connectors/signal/pairing-status?${params.toString()}`,
  );
};

lifeOpsClientPrototype.stopLifeOpsSignalPairing = async function (
  this: ElizaClient,
  data = { provider: "signal" },
): Promise<LifeOpsSignalPairingStatus> {
  return this.fetch<LifeOpsSignalPairingStatus>(
    "/api/lifeops/connectors/signal/stop",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

lifeOpsClientPrototype.disconnectSignalConnector = async function (
  this: ElizaClient,
  data = { provider: "signal" },
) {
  return this.fetch("/api/lifeops/connectors/signal/disconnect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getSignalConnectorMessages = async function (
  this: ElizaClient,
  options = {},
): Promise<GetLifeOpsSignalMessagesResponse> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch<GetLifeOpsSignalMessagesResponse>(
    `/api/lifeops/connectors/signal/messages${query}`,
  );
};

lifeOpsClientPrototype.sendSignalConnectorMessage = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/signal/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// ---------------------------------------------------------------------------
// Discord connector
// ---------------------------------------------------------------------------

lifeOpsClientPrototype.getDiscordConnectorStatus = async function (
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

lifeOpsClientPrototype.startDiscordConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/discord/connect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.disconnectDiscordConnector = async function (
  this: ElizaClient,
  data = { provider: "discord" },
) {
  return this.fetch("/api/lifeops/connectors/discord/disconnect", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.sendDiscordConnectorMessage = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/discord/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.verifyDiscordConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/discord/verify", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// ---------------------------------------------------------------------------
// WhatsApp connector
// ---------------------------------------------------------------------------

lifeOpsClientPrototype.getWhatsAppConnectorStatus = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/lifeops/connectors/whatsapp/status");
};

lifeOpsClientPrototype.sendWhatsAppConnectorMessage = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/whatsapp/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.getWhatsAppConnectorMessages = async function (
  this: ElizaClient,
  options = {},
) {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return this.fetch(`/api/lifeops/connectors/whatsapp/messages${query}`);
};

// ---------------------------------------------------------------------------
// Telegram connector
// ---------------------------------------------------------------------------

lifeOpsClientPrototype.getTelegramConnectorStatus = async function (
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

lifeOpsClientPrototype.startTelegramAuth = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/telegram/start", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.submitTelegramAuth = async function (
  this: ElizaClient,
  data,
) {
  return this.fetch("/api/lifeops/connectors/telegram/submit", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

lifeOpsClientPrototype.cancelTelegramAuth = async function (
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

lifeOpsClientPrototype.disconnectTelegramConnector = async function (
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

lifeOpsClientPrototype.verifyTelegramConnector = async function (
  this: ElizaClient,
  data = {},
) {
  return this.fetch("/api/lifeops/connectors/telegram/verify", {
    method: "POST",
    body: JSON.stringify(data),
  });
};
