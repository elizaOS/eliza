/** Preserves the public LifeOps repository and record factories while delegating persistence to domain owners and host adapters. All delegates share the original runtime database and transaction authority. */

export {
  createLifeOpsActivitySignal,
  type LifeOpsCircadianStateRow,
} from "./repositories/activity-telemetry-records.js";
export { createLifeOpsAuditEvent } from "./repositories/audit-ledger-records.js";
export {
  type BrowserCompanionPendingPromotionResult,
  type BrowserCompanionRevocation,
  createLifeOpsBrowserSession,
} from "./repositories/browser-records.js";
export { createLifeOpsCalendarSyncState } from "./repositories/calendar-records.js";
export {
  createLifeOpsChannelPolicy,
  createLifeOpsConnectorGrant,
  createLifeOpsWebsiteAccessGrant,
  type LifeOpsWebsiteAccessGrant,
} from "./repositories/connector-grant-records.js";
export type { LifeOpsEscalationStateRow } from "./repositories/escalation-records.js";
export { createLifeOpsGmailSyncState } from "./repositories/gmail-records.js";
export type { LifeOpsCachedInboxMessage } from "./repositories/inbox-cache-records.js";
export {
  createLifeOpsReminderAttempt,
  createLifeOpsReminderPlan,
} from "./repositories/reminder-records.js";
export {
  createLifeOpsTaskDefinition,
  type LifeOpsDefinitionScope,
  type LifeOpsScheduleInsightRecord,
  type LifeOpsScheduleMergedStateRecord,
  type LifeOpsScheduleObservationRecord,
} from "./repositories/schedule-projection-records.js";

import crypto from "node:crypto";
import {
  type EntityStore,
  type RelationshipStore,
  resolveKnowledgeGraphService,
} from "@elizaos/agent/services/knowledge-graph";
import type { IAgentRuntime } from "@elizaos/core";
import { FinancesRepository } from "@elizaos/plugin-finances/db/finances-repository";
import type {
  LifeOpsPaymentSource,
  LifeOpsPaymentTransaction,
} from "@elizaos/plugin-finances/payment-types";
import type {
  LifeOpsSubscriptionAudit,
  LifeOpsSubscriptionCancellation,
  LifeOpsSubscriptionCandidate,
} from "@elizaos/plugin-finances/subscriptions-types";
import { GoalsRepository } from "@elizaos/plugin-goals/db/goals-repository";
import type {
  LifeOpsGoalDefinition,
  LifeOpsGoalLink,
} from "../contracts/index.js";

export {
  createLifeOpsHealthMetricSample,
  createLifeOpsHealthSleepEpisode,
  createLifeOpsHealthSyncState,
  createLifeOpsHealthWorkout,
} from "@elizaos/plugin-health/health-bridge/health-records";
// Sleep- and health-record types + factories owned by `@elizaos/plugin-health`,
// re-exported here so existing app-lifeops importers keep resolving via the
// repository module. Sourced from the leaf modules (not the package barrel)
// because Vite's dep-optimizer scans even these type-only barrel specifiers and
// chokes on the dist-less @elizaos/plugin-health entry in the keyless lane.
export type {
  LifeOpsPersistedSleepEpisodeSource,
  LifeOpsSleepEpisodeRecord,
} from "@elizaos/plugin-health/sleep/sleep-episode-types";
export { createLifeOpsSleepEpisode } from "@elizaos/plugin-health/sleep/sleep-episode-types";

export type {
  LifeOpsBriefItemEngagementRecord,
  LifeOpsBriefItemEngagementWrite,
} from "./repositories/brief-engagement-records.js";

export {
  createLifeOpsWorkflowDefinition,
  createLifeOpsWorkflowRun,
} from "./repositories/workflow-records.js";

import { ActivityTelemetryRepository } from "./repositories/activity-telemetry.js";
import { AuditLedgerRepository } from "./repositories/audit-ledger.js";
import { BriefEngagementRepository } from "./repositories/brief-engagement.js";
import { BrowserCompanionRepository } from "./repositories/browser-companions.js";
import { BrowserContextRepository } from "./repositories/browser-context.js";
import { BrowserSessionRepository } from "./repositories/browser-sessions.js";
import { LifeOpsCalendarRepository } from "./repositories/calendar.js";
import { ConnectorGrantRepository } from "./repositories/connector-grants.js";
import { EscalationRepository } from "./repositories/escalation.js";
import { GmailRepository } from "./repositories/gmail.js";
import { HealthRepository } from "./repositories/health.js";
import { InboxCacheRepository } from "./repositories/inbox-cache.js";
import { NegotiationRepository } from "./repositories/negotiation.js";
import { isoNow } from "./repositories/record-values.js";
import { ReminderRepository } from "./repositories/reminders.js";
import { ScheduleProjectionRepository } from "./repositories/schedule-projections.js";
import { ScheduledTaskRepository } from "./repositories/scheduled-tasks.js";
import { SocialCacheRepository } from "./repositories/social-cache.js";
import { SpamReviewRepository } from "./repositories/spam-review.js";
import { WorkThreadRepository } from "./repositories/work-threads.js";
import { WorkflowRepository } from "./repositories/workflows.js";
import {
  bootstrapSchema,
  ensureActivitySignalColumns,
  ensureBrowserBridgeCompanionTokenColumns,
  ensureConnectorAccountColumns,
  ensureDefinitionCreationIdentity,
  ensureGmailSyncColumns,
  ensureInboxCacheIndexes,
  ensureReminderReviewColumns,
  ensureSchedulingNegotiationColumns,
  ensureWorkflowRunIdempotencyKey,
} from "./repository-bootstrap.js";

export class LifeOpsRepository {
  static ensureDefinitionCreationIdentity(
    runtime: IAgentRuntime,
  ): Promise<void> {
    return ensureDefinitionCreationIdentity(runtime);
  }
  getAuditEvent(
    ...args: Parameters<AuditLedgerRepository["getAuditEvent"]>
  ): ReturnType<AuditLedgerRepository["getAuditEvent"]> {
    return this.auditLedger.getAuditEvent(...args);
  }
  transitionUnscheduledTodo(
    ...args: Parameters<
      ScheduleProjectionRepository["transitionUnscheduledTodo"]
    >
  ): ReturnType<ScheduleProjectionRepository["transitionUnscheduledTodo"]> {
    return this.scheduleProjections.transitionUnscheduledTodo(...args);
  }
  completeDefinitionCreation(
    ...args: Parameters<
      ScheduleProjectionRepository["completeDefinitionCreation"]
    >
  ): ReturnType<ScheduleProjectionRepository["completeDefinitionCreation"]> {
    return this.scheduleProjections.completeDefinitionCreation(...args);
  }
  claimDefinitionCreation(
    ...args: Parameters<ScheduleProjectionRepository["claimDefinitionCreation"]>
  ): ReturnType<ScheduleProjectionRepository["claimDefinitionCreation"]> {
    return this.scheduleProjections.claimDefinitionCreation(...args);
  }
  private readonly browserSessions: BrowserSessionRepository;
  private readonly browserCompanions: BrowserCompanionRepository;
  private readonly browserContext: BrowserContextRepository;
  private readonly health: HealthRepository;
  private readonly calendar: LifeOpsCalendarRepository;
  private readonly gmail: GmailRepository;
  private readonly inboxCache: InboxCacheRepository;
  private readonly spamReview: SpamReviewRepository;
  private readonly reminders: ReminderRepository;
  private readonly negotiations: NegotiationRepository;
  private readonly scheduledTasks: ScheduledTaskRepository;
  private readonly connectorGrants: ConnectorGrantRepository;
  private readonly scheduleProjections: ScheduleProjectionRepository;
  private readonly auditLedger: AuditLedgerRepository;
  private readonly activityTelemetry: ActivityTelemetryRepository;
  private readonly escalations: EscalationRepository;
  private readonly socialCache: SocialCacheRepository;
  private readonly goalsRepo: GoalsRepository;
  private readonly workThreads: WorkThreadRepository;
  private readonly briefEngagements: BriefEngagementRepository;
  private readonly workflows: WorkflowRepository;
  /**
   * Per-agent counter for telemetry-mirror failures inside
   * {@link createActivitySignal}. The live signal insert is the primary
   * source of truth; mirror failures must not block persistence, but we
   * still want visibility when the mirror is broken. First failure logs,
   * then we throttle to once every 100 failures so a broken backend
   * doesn't flood logs.
   */

  /**
   * Finance back-end repository. The finance tables (payment sources /
   * transactions, subscription audits / candidates / cancellations) moved to
   * @elizaos/plugin-finances; the finance methods below delegate here so the
   * subscriptions mixin keeps reaching them through `this.repository`.
   */
  private readonly financesRepo: FinancesRepository;

  constructor(private readonly runtime: IAgentRuntime) {
    this.browserSessions = new BrowserSessionRepository(runtime);
    this.browserCompanions = new BrowserCompanionRepository(runtime);
    this.browserContext = new BrowserContextRepository(runtime);
    this.health = new HealthRepository(runtime);
    this.calendar = new LifeOpsCalendarRepository(runtime);
    this.gmail = new GmailRepository(runtime);
    this.inboxCache = new InboxCacheRepository(runtime);
    this.spamReview = new SpamReviewRepository(runtime);
    this.reminders = new ReminderRepository(runtime);
    this.negotiations = new NegotiationRepository(runtime);
    this.scheduledTasks = new ScheduledTaskRepository(runtime);
    this.connectorGrants = new ConnectorGrantRepository(runtime);
    this.scheduleProjections = new ScheduleProjectionRepository(runtime);
    this.auditLedger = new AuditLedgerRepository(runtime);
    this.activityTelemetry = new ActivityTelemetryRepository(runtime);
    this.escalations = new EscalationRepository(runtime);
    this.socialCache = new SocialCacheRepository(runtime);
    this.goalsRepo = new GoalsRepository(runtime);
    this.workThreads = new WorkThreadRepository(runtime);
    this.briefEngagements = new BriefEngagementRepository(runtime);
    this.workflows = new WorkflowRepository(runtime);
    this.financesRepo = new FinancesRepository(runtime);
  }

  /**
   * EntityStore / RelationshipStore accessors for the typed graph. The
   * knowledge graph is a runtime primitive owned by `@elizaos/agent`; these
   * factories resolve the per-agent stores from the registered
   * `KnowledgeGraphService` rather than constructing them directly.
   */
  private knowledgeGraph(): NonNullable<
    ReturnType<typeof resolveKnowledgeGraphService>
  > {
    const service = resolveKnowledgeGraphService(this.runtime);
    if (!service) {
      throw new Error(
        "[LifeOpsRepository] KnowledgeGraphService is not registered on the runtime",
      );
    }
    return service;
  }

  async entityStore(agentId: string): Promise<EntityStore> {
    return this.knowledgeGraph().getEntityStore(agentId);
  }

  async relationshipStore(agentId: string): Promise<RelationshipStore> {
    return this.knowledgeGraph().getRelationshipStore(agentId);
  }
  static async bootstrapSchema(runtime: IAgentRuntime): Promise<void> {
    return bootstrapSchema(runtime);
  }
  static async ensureWorkflowRunIdempotencyKey(
    runtime: IAgentRuntime,
  ): Promise<void> {
    return ensureWorkflowRunIdempotencyKey(runtime);
  }
  static async ensureSchedulingNegotiationColumns(
    runtime: IAgentRuntime,
  ): Promise<void> {
    return ensureSchedulingNegotiationColumns(runtime);
  }
  static async ensureActivitySignalColumns(
    runtime: IAgentRuntime,
  ): Promise<void> {
    return ensureActivitySignalColumns(runtime);
  }
  static async ensureBrowserBridgeCompanionTokenColumns(
    runtime: IAgentRuntime,
  ): Promise<void> {
    return ensureBrowserBridgeCompanionTokenColumns(runtime);
  }
  static async ensureReminderReviewColumns(
    runtime: IAgentRuntime,
  ): Promise<void> {
    return ensureReminderReviewColumns(runtime);
  }
  static async ensureConnectorAccountColumns(
    runtime: IAgentRuntime,
  ): Promise<void> {
    return ensureConnectorAccountColumns(runtime);
  }
  static async ensureGmailSyncColumns(runtime: IAgentRuntime): Promise<void> {
    return ensureGmailSyncColumns(runtime);
  }
  static async ensureInboxCacheIndexes(runtime: IAgentRuntime): Promise<void> {
    return ensureInboxCacheIndexes(runtime);
  }
  recordBriefItemEngagement(
    ...args: Parameters<BriefEngagementRepository["recordBriefItemEngagement"]>
  ): ReturnType<BriefEngagementRepository["recordBriefItemEngagement"]> {
    return this.briefEngagements.recordBriefItemEngagement(...args);
  }
  getBriefItemEngagement(
    ...args: Parameters<BriefEngagementRepository["getBriefItemEngagement"]>
  ): ReturnType<BriefEngagementRepository["getBriefItemEngagement"]> {
    return this.briefEngagements.getBriefItemEngagement(...args);
  }
  listBriefItemEngagements(
    ...args: Parameters<BriefEngagementRepository["listBriefItemEngagements"]>
  ): ReturnType<BriefEngagementRepository["listBriefItemEngagements"]> {
    return this.briefEngagements.listBriefItemEngagements(...args);
  }
  listPendingBriefEngagementRewards(
    ...args: Parameters<
      BriefEngagementRepository["listPendingBriefEngagementRewards"]
    >
  ): ReturnType<
    BriefEngagementRepository["listPendingBriefEngagementRewards"]
  > {
    return this.briefEngagements.listPendingBriefEngagementRewards(...args);
  }
  summarizeBriefItemEngagements(
    ...args: Parameters<
      BriefEngagementRepository["summarizeBriefItemEngagements"]
    >
  ): ReturnType<BriefEngagementRepository["summarizeBriefItemEngagements"]> {
    return this.briefEngagements.summarizeBriefItemEngagements(...args);
  }
  attributeBriefItemEngagement(
    ...args: Parameters<
      BriefEngagementRepository["attributeBriefItemEngagement"]
    >
  ): ReturnType<BriefEngagementRepository["attributeBriefItemEngagement"]> {
    return this.briefEngagements.attributeBriefItemEngagement(...args);
  }
  finalizeExpiredBriefItemEngagements(
    ...args: Parameters<
      BriefEngagementRepository["finalizeExpiredBriefItemEngagements"]
    >
  ): ReturnType<
    BriefEngagementRepository["finalizeExpiredBriefItemEngagements"]
  > {
    return this.briefEngagements.finalizeExpiredBriefItemEngagements(...args);
  }
  claimBriefEngagementReward(
    ...args: Parameters<BriefEngagementRepository["claimBriefEngagementReward"]>
  ): ReturnType<BriefEngagementRepository["claimBriefEngagementReward"]> {
    return this.briefEngagements.claimBriefEngagementReward(...args);
  }
  completeBriefEngagementRewardClaim(
    ...args: Parameters<
      BriefEngagementRepository["completeBriefEngagementRewardClaim"]
    >
  ): ReturnType<
    BriefEngagementRepository["completeBriefEngagementRewardClaim"]
  > {
    return this.briefEngagements.completeBriefEngagementRewardClaim(...args);
  }
  releaseBriefEngagementRewardClaim(
    ...args: Parameters<
      BriefEngagementRepository["releaseBriefEngagementRewardClaim"]
    >
  ): ReturnType<
    BriefEngagementRepository["releaseBriefEngagementRewardClaim"]
  > {
    return this.briefEngagements.releaseBriefEngagementRewardClaim(...args);
  }
  createDefinition(
    ...args: Parameters<ScheduleProjectionRepository["createDefinition"]>
  ): ReturnType<ScheduleProjectionRepository["createDefinition"]> {
    return this.scheduleProjections.createDefinition(...args);
  }
  updateDefinition(
    ...args: Parameters<ScheduleProjectionRepository["updateDefinition"]>
  ): ReturnType<ScheduleProjectionRepository["updateDefinition"]> {
    return this.scheduleProjections.updateDefinition(...args);
  }
  getDefinition(
    ...args: Parameters<ScheduleProjectionRepository["getDefinition"]>
  ): ReturnType<ScheduleProjectionRepository["getDefinition"]> {
    return this.scheduleProjections.getDefinition(...args);
  }
  listDefinitions(
    ...args: Parameters<ScheduleProjectionRepository["listDefinitions"]>
  ): ReturnType<ScheduleProjectionRepository["listDefinitions"]> {
    return this.scheduleProjections.listDefinitions(...args);
  }
  listActiveDefinitions(
    ...args: Parameters<ScheduleProjectionRepository["listActiveDefinitions"]>
  ): ReturnType<ScheduleProjectionRepository["listActiveDefinitions"]> {
    return this.scheduleProjections.listActiveDefinitions(...args);
  }
  deleteDefinition(
    ...args: Parameters<ScheduleProjectionRepository["deleteDefinition"]>
  ): ReturnType<ScheduleProjectionRepository["deleteDefinition"]> {
    return this.scheduleProjections.deleteDefinition(...args);
  }
  upsertOccurrence(
    ...args: Parameters<ScheduleProjectionRepository["upsertOccurrence"]>
  ): ReturnType<ScheduleProjectionRepository["upsertOccurrence"]> {
    return this.scheduleProjections.upsertOccurrence(...args);
  }
  listOccurrencesForDefinition(
    ...args: Parameters<
      ScheduleProjectionRepository["listOccurrencesForDefinition"]
    >
  ): ReturnType<ScheduleProjectionRepository["listOccurrencesForDefinition"]> {
    return this.scheduleProjections.listOccurrencesForDefinition(...args);
  }
  listOccurrencesForDefinitions(
    ...args: Parameters<
      ScheduleProjectionRepository["listOccurrencesForDefinitions"]
    >
  ): ReturnType<ScheduleProjectionRepository["listOccurrencesForDefinitions"]> {
    return this.scheduleProjections.listOccurrencesForDefinitions(...args);
  }
  getOccurrence(
    ...args: Parameters<ScheduleProjectionRepository["getOccurrence"]>
  ): ReturnType<ScheduleProjectionRepository["getOccurrence"]> {
    return this.scheduleProjections.getOccurrence(...args);
  }
  getOccurrenceView(
    ...args: Parameters<ScheduleProjectionRepository["getOccurrenceView"]>
  ): ReturnType<ScheduleProjectionRepository["getOccurrenceView"]> {
    return this.scheduleProjections.getOccurrenceView(...args);
  }
  listOccurrenceViewsForOverview(
    ...args: Parameters<
      ScheduleProjectionRepository["listOccurrenceViewsForOverview"]
    >
  ): ReturnType<
    ScheduleProjectionRepository["listOccurrenceViewsForOverview"]
  > {
    return this.scheduleProjections.listOccurrenceViewsForOverview(...args);
  }
  listCompletedOccurrenceViewsSince(
    ...args: Parameters<
      ScheduleProjectionRepository["listCompletedOccurrenceViewsSince"]
    >
  ): ReturnType<
    ScheduleProjectionRepository["listCompletedOccurrenceViewsSince"]
  > {
    return this.scheduleProjections.listCompletedOccurrenceViewsSince(...args);
  }
  updateOccurrence(
    ...args: Parameters<ScheduleProjectionRepository["updateOccurrence"]>
  ): ReturnType<ScheduleProjectionRepository["updateOccurrence"]> {
    return this.scheduleProjections.updateOccurrence(...args);
  }
  completeOccurrenceIfNonTerminal(
    ...args: Parameters<
      ScheduleProjectionRepository["completeOccurrenceIfNonTerminal"]
    >
  ): ReturnType<
    ScheduleProjectionRepository["completeOccurrenceIfNonTerminal"]
  > {
    return this.scheduleProjections.completeOccurrenceIfNonTerminal(...args);
  }
  pruneNonTerminalOccurrences(
    ...args: Parameters<
      ScheduleProjectionRepository["pruneNonTerminalOccurrences"]
    >
  ): ReturnType<ScheduleProjectionRepository["pruneNonTerminalOccurrences"]> {
    return this.scheduleProjections.pruneNonTerminalOccurrences(...args);
  }

  async createGoal(goal: LifeOpsGoalDefinition): Promise<void> {
    return this.goalsRepo.createGoal(goal);
  }

  async updateGoal(goal: LifeOpsGoalDefinition): Promise<void> {
    return this.goalsRepo.updateGoal(goal);
  }

  async getGoal(
    agentId: string,
    goalId: string,
  ): Promise<LifeOpsGoalDefinition | null> {
    return this.goalsRepo.getGoal(agentId, goalId);
  }

  async listGoals(agentId: string): Promise<LifeOpsGoalDefinition[]> {
    return this.goalsRepo.listGoals(agentId);
  }

  async deleteGoal(agentId: string, goalId: string): Promise<void> {
    return this.goalsRepo.deleteGoal(agentId, goalId);
  }

  async upsertGoalLink(link: LifeOpsGoalLink): Promise<void> {
    return this.goalsRepo.upsertGoalLink(link);
  }

  async deleteGoalLinksForLinked(
    agentId: string,
    linkedType: LifeOpsGoalLink["linkedType"],
    linkedId: string,
  ): Promise<void> {
    return this.goalsRepo.deleteGoalLinksForLinked(
      agentId,
      linkedType,
      linkedId,
    );
  }

  async listGoalLinksForGoal(
    agentId: string,
    goalId: string,
  ): Promise<LifeOpsGoalLink[]> {
    return this.goalsRepo.listGoalLinksForGoal(agentId, goalId);
  }
  createReminderPlan(
    ...args: Parameters<ReminderRepository["createReminderPlan"]>
  ): ReturnType<ReminderRepository["createReminderPlan"]> {
    return this.reminders.createReminderPlan(...args);
  }
  updateReminderPlan(
    ...args: Parameters<ReminderRepository["updateReminderPlan"]>
  ): ReturnType<ReminderRepository["updateReminderPlan"]> {
    return this.reminders.updateReminderPlan(...args);
  }
  deleteReminderPlan(
    ...args: Parameters<ReminderRepository["deleteReminderPlan"]>
  ): ReturnType<ReminderRepository["deleteReminderPlan"]> {
    return this.reminders.deleteReminderPlan(...args);
  }
  getReminderPlan(
    ...args: Parameters<ReminderRepository["getReminderPlan"]>
  ): ReturnType<ReminderRepository["getReminderPlan"]> {
    return this.reminders.getReminderPlan(...args);
  }
  listReminderPlansForOwners(
    ...args: Parameters<ReminderRepository["listReminderPlansForOwners"]>
  ): ReturnType<ReminderRepository["listReminderPlansForOwners"]> {
    return this.reminders.listReminderPlansForOwners(...args);
  }
  createAuditEvent(
    ...args: Parameters<AuditLedgerRepository["createAuditEvent"]>
  ): ReturnType<AuditLedgerRepository["createAuditEvent"]> {
    return this.auditLedger.createAuditEvent(...args);
  }
  appendProgressEventIfNew(
    ...args: Parameters<AuditLedgerRepository["appendProgressEventIfNew"]>
  ): ReturnType<AuditLedgerRepository["appendProgressEventIfNew"]> {
    return this.auditLedger.appendProgressEventIfNew(...args);
  }
  sumProgressEvents(
    ...args: Parameters<AuditLedgerRepository["sumProgressEvents"]>
  ): ReturnType<AuditLedgerRepository["sumProgressEvents"]> {
    return this.auditLedger.sumProgressEvents(...args);
  }
  listProgressEvents(
    ...args: Parameters<AuditLedgerRepository["listProgressEvents"]>
  ): ReturnType<AuditLedgerRepository["listProgressEvents"]> {
    return this.auditLedger.listProgressEvents(...args);
  }
  createAuditEventIfNew(
    ...args: Parameters<AuditLedgerRepository["createAuditEventIfNew"]>
  ): ReturnType<AuditLedgerRepository["createAuditEventIfNew"]> {
    return this.auditLedger.createAuditEventIfNew(...args);
  }
  listAuditEvents(
    ...args: Parameters<AuditLedgerRepository["listAuditEvents"]>
  ): ReturnType<AuditLedgerRepository["listAuditEvents"]> {
    return this.auditLedger.listAuditEvents(...args);
  }
  upsertCommitmentLedgerRecord(
    ...args: Parameters<AuditLedgerRepository["upsertCommitmentLedgerRecord"]>
  ): ReturnType<AuditLedgerRepository["upsertCommitmentLedgerRecord"]> {
    return this.auditLedger.upsertCommitmentLedgerRecord(...args);
  }
  getCommitmentLedgerRecord(
    ...args: Parameters<AuditLedgerRepository["getCommitmentLedgerRecord"]>
  ): ReturnType<AuditLedgerRepository["getCommitmentLedgerRecord"]> {
    return this.auditLedger.getCommitmentLedgerRecord(...args);
  }
  listCommitmentLedgerRecords(
    ...args: Parameters<AuditLedgerRepository["listCommitmentLedgerRecords"]>
  ): ReturnType<AuditLedgerRepository["listCommitmentLedgerRecords"]> {
    return this.auditLedger.listCommitmentLedgerRecords(...args);
  }
  upsertDelegationContract(
    ...args: Parameters<AuditLedgerRepository["upsertDelegationContract"]>
  ): ReturnType<AuditLedgerRepository["upsertDelegationContract"]> {
    return this.auditLedger.upsertDelegationContract(...args);
  }
  getDelegationContract(
    ...args: Parameters<AuditLedgerRepository["getDelegationContract"]>
  ): ReturnType<AuditLedgerRepository["getDelegationContract"]> {
    return this.auditLedger.getDelegationContract(...args);
  }
  listDelegationContracts(
    ...args: Parameters<AuditLedgerRepository["listDelegationContracts"]>
  ): ReturnType<AuditLedgerRepository["listDelegationContracts"]> {
    return this.auditLedger.listDelegationContracts(...args);
  }

  // ---------------------------------------------------------------------
  // Finance (subscription) delegations → @elizaos/plugin-finances.
  // The raw SQL lives in FinancesRepository; these wrappers keep the
  // subscriptions mixin reaching the finance tables through `this.repository`.
  // ---------------------------------------------------------------------

  async createSubscriptionAudit(
    audit: LifeOpsSubscriptionAudit,
  ): Promise<void> {
    return this.financesRepo.createSubscriptionAudit(audit);
  }

  async updateSubscriptionAudit(
    audit: LifeOpsSubscriptionAudit,
  ): Promise<void> {
    return this.financesRepo.updateSubscriptionAudit(audit);
  }

  async getSubscriptionAudit(
    agentId: string,
    auditId: string,
  ): Promise<LifeOpsSubscriptionAudit | null> {
    return this.financesRepo.getSubscriptionAudit(agentId, auditId);
  }

  async getLatestSubscriptionAudit(
    agentId: string,
  ): Promise<LifeOpsSubscriptionAudit | null> {
    return this.financesRepo.getLatestSubscriptionAudit(agentId);
  }

  async createSubscriptionCandidate(
    candidate: LifeOpsSubscriptionCandidate,
  ): Promise<void> {
    return this.financesRepo.createSubscriptionCandidate(candidate);
  }

  async listSubscriptionCandidatesForAudit(
    agentId: string,
    auditId: string,
  ): Promise<LifeOpsSubscriptionCandidate[]> {
    return this.financesRepo.listSubscriptionCandidatesForAudit(
      agentId,
      auditId,
    );
  }

  async getSubscriptionCandidate(
    agentId: string,
    candidateId: string,
  ): Promise<LifeOpsSubscriptionCandidate | null> {
    return this.financesRepo.getSubscriptionCandidate(agentId, candidateId);
  }

  async createSubscriptionCancellation(
    cancellation: LifeOpsSubscriptionCancellation,
  ): Promise<void> {
    return this.financesRepo.createSubscriptionCancellation(cancellation);
  }

  async updateSubscriptionCancellation(
    cancellation: LifeOpsSubscriptionCancellation,
  ): Promise<void> {
    return this.financesRepo.updateSubscriptionCancellation(cancellation);
  }

  async getSubscriptionCancellation(
    agentId: string,
    cancellationId: string,
  ): Promise<LifeOpsSubscriptionCancellation | null> {
    return this.financesRepo.getSubscriptionCancellation(
      agentId,
      cancellationId,
    );
  }

  async getLatestSubscriptionCancellation(
    agentId: string,
    serviceSlug?: string,
  ): Promise<LifeOpsSubscriptionCancellation | null> {
    return this.financesRepo.getLatestSubscriptionCancellation(
      agentId,
      serviceSlug,
    );
  }

  // Email-unsubscribe persistence (the `app_lifeops.life_email_unsubscribes`
  // table this schema still registers) moved to `@elizaos/plugin-inbox`'s
  // `InboxUnsubscribeRepository`. PA's email-unsubscribe mixin now delegates to
  // the inbox service, so LifeOpsRepository no longer carries those reads/writes.

  // ---------------------------------------------------------------------
  // Finance (payment) delegations → @elizaos/plugin-finances.
  // ---------------------------------------------------------------------

  async upsertPaymentSource(source: LifeOpsPaymentSource): Promise<void> {
    return this.financesRepo.upsertPaymentSource(source);
  }

  async listPaymentSources(agentId: string): Promise<LifeOpsPaymentSource[]> {
    return this.financesRepo.listPaymentSources(agentId);
  }

  async getPaymentSource(
    agentId: string,
    sourceId: string,
  ): Promise<LifeOpsPaymentSource | null> {
    return this.financesRepo.getPaymentSource(agentId, sourceId);
  }

  async deletePaymentSource(agentId: string, sourceId: string): Promise<void> {
    return this.financesRepo.deletePaymentSource(agentId, sourceId);
  }

  async deletePaymentTransactionById(
    agentId: string,
    transactionId: string,
  ): Promise<void> {
    return this.financesRepo.deletePaymentTransactionById(
      agentId,
      transactionId,
    );
  }

  async insertPaymentTransaction(
    transaction: LifeOpsPaymentTransaction,
  ): Promise<boolean> {
    return this.financesRepo.insertPaymentTransaction(transaction);
  }

  async listPaymentTransactions(
    agentId: string,
    args: {
      sourceId?: string | null;
      sinceAt?: string | null;
      untilAt?: string | null;
      limit?: number | null;
      merchantContains?: string | null;
      onlyDebits?: boolean | null;
    } = {},
  ): Promise<LifeOpsPaymentTransaction[]> {
    return this.financesRepo.listPaymentTransactions(agentId, args);
  }

  async countPaymentTransactionsForSource(
    agentId: string,
    sourceId: string,
  ): Promise<number> {
    return this.financesRepo.countPaymentTransactionsForSource(
      agentId,
      sourceId,
    );
  }
  createActivitySignal(
    ...args: Parameters<ActivityTelemetryRepository["createActivitySignal"]>
  ): ReturnType<ActivityTelemetryRepository["createActivitySignal"]> {
    return this.activityTelemetry.createActivitySignal(...args);
  }
  listActivitySignals(
    ...args: Parameters<ActivityTelemetryRepository["listActivitySignals"]>
  ): ReturnType<ActivityTelemetryRepository["listActivitySignals"]> {
    return this.activityTelemetry.listActivitySignals(...args);
  }
  upsertHealthMetricSample(
    ...args: Parameters<HealthRepository["upsertHealthMetricSample"]>
  ): ReturnType<HealthRepository["upsertHealthMetricSample"]> {
    return this.health.upsertHealthMetricSample(...args);
  }
  listHealthMetricSamples(
    ...args: Parameters<HealthRepository["listHealthMetricSamples"]>
  ): ReturnType<HealthRepository["listHealthMetricSamples"]> {
    return this.health.listHealthMetricSamples(...args);
  }
  upsertHealthWorkout(
    ...args: Parameters<HealthRepository["upsertHealthWorkout"]>
  ): ReturnType<HealthRepository["upsertHealthWorkout"]> {
    return this.health.upsertHealthWorkout(...args);
  }
  listHealthWorkouts(
    ...args: Parameters<HealthRepository["listHealthWorkouts"]>
  ): ReturnType<HealthRepository["listHealthWorkouts"]> {
    return this.health.listHealthWorkouts(...args);
  }
  upsertHealthSleepEpisode(
    ...args: Parameters<HealthRepository["upsertHealthSleepEpisode"]>
  ): ReturnType<HealthRepository["upsertHealthSleepEpisode"]> {
    return this.health.upsertHealthSleepEpisode(...args);
  }
  listHealthSleepEpisodes(
    ...args: Parameters<HealthRepository["listHealthSleepEpisodes"]>
  ): ReturnType<HealthRepository["listHealthSleepEpisodes"]> {
    return this.health.listHealthSleepEpisodes(...args);
  }
  upsertHealthSyncState(
    ...args: Parameters<HealthRepository["upsertHealthSyncState"]>
  ): ReturnType<HealthRepository["upsertHealthSyncState"]> {
    return this.health.upsertHealthSyncState(...args);
  }
  getHealthSyncState(
    ...args: Parameters<HealthRepository["getHealthSyncState"]>
  ): ReturnType<HealthRepository["getHealthSyncState"]> {
    return this.health.getHealthSyncState(...args);
  }
  upsertChannelPolicy(
    ...args: Parameters<ConnectorGrantRepository["upsertChannelPolicy"]>
  ): ReturnType<ConnectorGrantRepository["upsertChannelPolicy"]> {
    return this.connectorGrants.upsertChannelPolicy(...args);
  }
  listChannelPolicies(
    ...args: Parameters<ConnectorGrantRepository["listChannelPolicies"]>
  ): ReturnType<ConnectorGrantRepository["listChannelPolicies"]> {
    return this.connectorGrants.listChannelPolicies(...args);
  }
  getChannelPolicy(
    ...args: Parameters<ConnectorGrantRepository["getChannelPolicy"]>
  ): ReturnType<ConnectorGrantRepository["getChannelPolicy"]> {
    return this.connectorGrants.getChannelPolicy(...args);
  }
  upsertWebsiteAccessGrant(
    ...args: Parameters<ConnectorGrantRepository["upsertWebsiteAccessGrant"]>
  ): ReturnType<ConnectorGrantRepository["upsertWebsiteAccessGrant"]> {
    return this.connectorGrants.upsertWebsiteAccessGrant(...args);
  }
  listWebsiteAccessGrants(
    ...args: Parameters<ConnectorGrantRepository["listWebsiteAccessGrants"]>
  ): ReturnType<ConnectorGrantRepository["listWebsiteAccessGrants"]> {
    return this.connectorGrants.listWebsiteAccessGrants(...args);
  }
  revokeWebsiteAccessGrants(
    ...args: Parameters<ConnectorGrantRepository["revokeWebsiteAccessGrants"]>
  ): ReturnType<ConnectorGrantRepository["revokeWebsiteAccessGrants"]> {
    return this.connectorGrants.revokeWebsiteAccessGrants(...args);
  }
  ensureConnectorAccountPrivacy(
    ...args: Parameters<
      ConnectorGrantRepository["ensureConnectorAccountPrivacy"]
    >
  ): ReturnType<ConnectorGrantRepository["ensureConnectorAccountPrivacy"]> {
    return this.connectorGrants.ensureConnectorAccountPrivacy(...args);
  }
  upsertConnectorAccountPrivacy(
    ...args: Parameters<
      ConnectorGrantRepository["upsertConnectorAccountPrivacy"]
    >
  ): ReturnType<ConnectorGrantRepository["upsertConnectorAccountPrivacy"]> {
    return this.connectorGrants.upsertConnectorAccountPrivacy(...args);
  }
  listConnectorAccountPrivacy(
    ...args: Parameters<ConnectorGrantRepository["listConnectorAccountPrivacy"]>
  ): ReturnType<ConnectorGrantRepository["listConnectorAccountPrivacy"]> {
    return this.connectorGrants.listConnectorAccountPrivacy(...args);
  }
  getConnectorAccountPrivacy(
    ...args: Parameters<ConnectorGrantRepository["getConnectorAccountPrivacy"]>
  ): ReturnType<ConnectorGrantRepository["getConnectorAccountPrivacy"]> {
    return this.connectorGrants.getConnectorAccountPrivacy(...args);
  }
  upsertConnectorGrant(
    ...args: Parameters<ConnectorGrantRepository["upsertConnectorGrant"]>
  ): ReturnType<ConnectorGrantRepository["upsertConnectorGrant"]> {
    return this.connectorGrants.upsertConnectorGrant(...args);
  }
  listConnectorGrants(
    ...args: Parameters<ConnectorGrantRepository["listConnectorGrants"]>
  ): ReturnType<ConnectorGrantRepository["listConnectorGrants"]> {
    return this.connectorGrants.listConnectorGrants(...args);
  }
  getConnectorGrant(
    ...args: Parameters<ConnectorGrantRepository["getConnectorGrant"]>
  ): ReturnType<ConnectorGrantRepository["getConnectorGrant"]> {
    return this.connectorGrants.getConnectorGrant(...args);
  }
  deleteConnectorGrant(
    ...args: Parameters<ConnectorGrantRepository["deleteConnectorGrant"]>
  ): ReturnType<ConnectorGrantRepository["deleteConnectorGrant"]> {
    return this.connectorGrants.deleteConnectorGrant(...args);
  }
  upsertCalendarEvent(
    ...args: Parameters<LifeOpsCalendarRepository["upsertCalendarEvent"]>
  ): ReturnType<LifeOpsCalendarRepository["upsertCalendarEvent"]> {
    return this.calendar.upsertCalendarEvent(...args);
  }
  deleteCalendarEventsForProvider(
    ...args: Parameters<
      LifeOpsCalendarRepository["deleteCalendarEventsForProvider"]
    >
  ): ReturnType<LifeOpsCalendarRepository["deleteCalendarEventsForProvider"]> {
    return this.calendar.deleteCalendarEventsForProvider(...args);
  }
  deleteCalendarEventByExternalId(
    ...args: Parameters<
      LifeOpsCalendarRepository["deleteCalendarEventByExternalId"]
    >
  ): ReturnType<LifeOpsCalendarRepository["deleteCalendarEventByExternalId"]> {
    return this.calendar.deleteCalendarEventByExternalId(...args);
  }
  pruneCalendarEventsInWindow(
    ...args: Parameters<
      LifeOpsCalendarRepository["pruneCalendarEventsInWindow"]
    >
  ): ReturnType<LifeOpsCalendarRepository["pruneCalendarEventsInWindow"]> {
    return this.calendar.pruneCalendarEventsInWindow(...args);
  }
  listCalendarEvents(
    ...args: Parameters<LifeOpsCalendarRepository["listCalendarEvents"]>
  ): ReturnType<LifeOpsCalendarRepository["listCalendarEvents"]> {
    return this.calendar.listCalendarEvents(...args);
  }
  listCalendarEventsEndedAfterCursor(
    ...args: Parameters<
      LifeOpsCalendarRepository["listCalendarEventsEndedAfterCursor"]
    >
  ): ReturnType<
    LifeOpsCalendarRepository["listCalendarEventsEndedAfterCursor"]
  > {
    return this.calendar.listCalendarEventsEndedAfterCursor(...args);
  }
  upsertCalendarSyncState(
    ...args: Parameters<LifeOpsCalendarRepository["upsertCalendarSyncState"]>
  ): ReturnType<LifeOpsCalendarRepository["upsertCalendarSyncState"]> {
    return this.calendar.upsertCalendarSyncState(...args);
  }
  getCalendarSyncState(
    ...args: Parameters<LifeOpsCalendarRepository["getCalendarSyncState"]>
  ): ReturnType<LifeOpsCalendarRepository["getCalendarSyncState"]> {
    return this.calendar.getCalendarSyncState(...args);
  }
  deleteCalendarSyncState(
    ...args: Parameters<LifeOpsCalendarRepository["deleteCalendarSyncState"]>
  ): ReturnType<LifeOpsCalendarRepository["deleteCalendarSyncState"]> {
    return this.calendar.deleteCalendarSyncState(...args);
  }
  upsertGmailMessage(
    ...args: Parameters<GmailRepository["upsertGmailMessage"]>
  ): ReturnType<GmailRepository["upsertGmailMessage"]> {
    return this.gmail.upsertGmailMessage(...args);
  }
  publishGmailSeed(
    ...args: Parameters<GmailRepository["publishGmailSeed"]>
  ): ReturnType<GmailRepository["publishGmailSeed"]> {
    return this.gmail.publishGmailSeed(...args);
  }
  pruneGmailMessages(
    ...args: Parameters<GmailRepository["pruneGmailMessages"]>
  ): ReturnType<GmailRepository["pruneGmailMessages"]> {
    return this.gmail.pruneGmailMessages(...args);
  }
  listGmailMessages(
    ...args: Parameters<GmailRepository["listGmailMessages"]>
  ): ReturnType<GmailRepository["listGmailMessages"]> {
    return this.gmail.listGmailMessages(...args);
  }
  countGmailMessages(
    ...args: Parameters<GmailRepository["countGmailMessages"]>
  ): ReturnType<GmailRepository["countGmailMessages"]> {
    return this.gmail.countGmailMessages(...args);
  }
  getGmailMessage(
    ...args: Parameters<GmailRepository["getGmailMessage"]>
  ): ReturnType<GmailRepository["getGmailMessage"]> {
    return this.gmail.getGmailMessage(...args);
  }
  upsertCachedInboxMessages(
    ...args: Parameters<InboxCacheRepository["upsertCachedInboxMessages"]>
  ): ReturnType<InboxCacheRepository["upsertCachedInboxMessages"]> {
    return this.inboxCache.upsertCachedInboxMessages(...args);
  }
  listCachedInboxMessages(
    ...args: Parameters<InboxCacheRepository["listCachedInboxMessages"]>
  ): ReturnType<InboxCacheRepository["listCachedInboxMessages"]> {
    return this.inboxCache.listCachedInboxMessages(...args);
  }
  markCachedInboxMessageRead(
    ...args: Parameters<InboxCacheRepository["markCachedInboxMessageRead"]>
  ): ReturnType<InboxCacheRepository["markCachedInboxMessageRead"]> {
    return this.inboxCache.markCachedInboxMessageRead(...args);
  }
  deleteGmailMessages(
    ...args: Parameters<GmailRepository["deleteGmailMessages"]>
  ): ReturnType<GmailRepository["deleteGmailMessages"]> {
    return this.gmail.deleteGmailMessages(...args);
  }
  deleteGmailMessagesByExternalId(
    ...args: Parameters<GmailRepository["deleteGmailMessagesByExternalId"]>
  ): ReturnType<GmailRepository["deleteGmailMessagesByExternalId"]> {
    return this.gmail.deleteGmailMessagesByExternalId(...args);
  }
  deleteGmailMessagesForProvider(
    ...args: Parameters<GmailRepository["deleteGmailMessagesForProvider"]>
  ): ReturnType<GmailRepository["deleteGmailMessagesForProvider"]> {
    return this.gmail.deleteGmailMessagesForProvider(...args);
  }
  upsertGmailSyncState(
    ...args: Parameters<GmailRepository["upsertGmailSyncState"]>
  ): ReturnType<GmailRepository["upsertGmailSyncState"]> {
    return this.gmail.upsertGmailSyncState(...args);
  }
  getGmailSyncState(
    ...args: Parameters<GmailRepository["getGmailSyncState"]>
  ): ReturnType<GmailRepository["getGmailSyncState"]> {
    return this.gmail.getGmailSyncState(...args);
  }
  deleteGmailSyncState(
    ...args: Parameters<GmailRepository["deleteGmailSyncState"]>
  ): ReturnType<GmailRepository["deleteGmailSyncState"]> {
    return this.gmail.deleteGmailSyncState(...args);
  }
  upsertGmailSpamReviewItem(
    ...args: Parameters<SpamReviewRepository["upsertGmailSpamReviewItem"]>
  ): ReturnType<SpamReviewRepository["upsertGmailSpamReviewItem"]> {
    return this.spamReview.upsertGmailSpamReviewItem(...args);
  }
  listGmailSpamReviewItems(
    ...args: Parameters<SpamReviewRepository["listGmailSpamReviewItems"]>
  ): ReturnType<SpamReviewRepository["listGmailSpamReviewItems"]> {
    return this.spamReview.listGmailSpamReviewItems(...args);
  }
  countGmailSpamReviewItems(
    ...args: Parameters<SpamReviewRepository["countGmailSpamReviewItems"]>
  ): ReturnType<SpamReviewRepository["countGmailSpamReviewItems"]> {
    return this.spamReview.countGmailSpamReviewItems(...args);
  }
  getGmailSpamReviewItem(
    ...args: Parameters<SpamReviewRepository["getGmailSpamReviewItem"]>
  ): ReturnType<SpamReviewRepository["getGmailSpamReviewItem"]> {
    return this.spamReview.getGmailSpamReviewItem(...args);
  }
  updateGmailSpamReviewItemStatus(
    ...args: Parameters<SpamReviewRepository["updateGmailSpamReviewItemStatus"]>
  ): ReturnType<SpamReviewRepository["updateGmailSpamReviewItemStatus"]> {
    return this.spamReview.updateGmailSpamReviewItemStatus(...args);
  }
  deleteGmailSpamReviewItemsForProvider(
    ...args: Parameters<
      SpamReviewRepository["deleteGmailSpamReviewItemsForProvider"]
    >
  ): ReturnType<SpamReviewRepository["deleteGmailSpamReviewItemsForProvider"]> {
    return this.spamReview.deleteGmailSpamReviewItemsForProvider(...args);
  }
  createWorkflow(
    ...args: Parameters<WorkflowRepository["createWorkflow"]>
  ): ReturnType<WorkflowRepository["createWorkflow"]> {
    return this.workflows.createWorkflow(...args);
  }
  updateWorkflow(
    ...args: Parameters<WorkflowRepository["updateWorkflow"]>
  ): ReturnType<WorkflowRepository["updateWorkflow"]> {
    return this.workflows.updateWorkflow(...args);
  }
  listWorkflows(
    ...args: Parameters<WorkflowRepository["listWorkflows"]>
  ): ReturnType<WorkflowRepository["listWorkflows"]> {
    return this.workflows.listWorkflows(...args);
  }
  deleteWorkflow(
    ...args: Parameters<WorkflowRepository["deleteWorkflow"]>
  ): ReturnType<WorkflowRepository["deleteWorkflow"]> {
    return this.workflows.deleteWorkflow(...args);
  }
  getWorkflow(
    ...args: Parameters<WorkflowRepository["getWorkflow"]>
  ): ReturnType<WorkflowRepository["getWorkflow"]> {
    return this.workflows.getWorkflow(...args);
  }
  createWorkflowRun(
    ...args: Parameters<WorkflowRepository["createWorkflowRun"]>
  ): ReturnType<WorkflowRepository["createWorkflowRun"]> {
    return this.workflows.createWorkflowRun(...args);
  }
  claimWorkflowRun(
    ...args: Parameters<WorkflowRepository["claimWorkflowRun"]>
  ): ReturnType<WorkflowRepository["claimWorkflowRun"]> {
    return this.workflows.claimWorkflowRun(...args);
  }
  getWorkflowRunByIdempotencyKey(
    ...args: Parameters<WorkflowRepository["getWorkflowRunByIdempotencyKey"]>
  ): ReturnType<WorkflowRepository["getWorkflowRunByIdempotencyKey"]> {
    return this.workflows.getWorkflowRunByIdempotencyKey(...args);
  }
  completeWorkflowRun(
    ...args: Parameters<WorkflowRepository["completeWorkflowRun"]>
  ): ReturnType<WorkflowRepository["completeWorkflowRun"]> {
    return this.workflows.completeWorkflowRun(...args);
  }
  listWorkflowRuns(
    ...args: Parameters<WorkflowRepository["listWorkflowRuns"]>
  ): ReturnType<WorkflowRepository["listWorkflowRuns"]> {
    return this.workflows.listWorkflowRuns(...args);
  }
  createReminderAttempt(
    ...args: Parameters<ReminderRepository["createReminderAttempt"]>
  ): ReturnType<ReminderRepository["createReminderAttempt"]> {
    return this.reminders.createReminderAttempt(...args);
  }
  listReminderAttempts(
    ...args: Parameters<ReminderRepository["listReminderAttempts"]>
  ): ReturnType<ReminderRepository["listReminderAttempts"]> {
    return this.reminders.listReminderAttempts(...args);
  }
  listDueReminderReviewAttempts(
    ...args: Parameters<ReminderRepository["listDueReminderReviewAttempts"]>
  ): ReturnType<ReminderRepository["listDueReminderReviewAttempts"]> {
    return this.reminders.listDueReminderReviewAttempts(...args);
  }
  claimDueReminderReviewAttempts(
    ...args: Parameters<ReminderRepository["claimDueReminderReviewAttempts"]>
  ): ReturnType<ReminderRepository["claimDueReminderReviewAttempts"]> {
    return this.reminders.claimDueReminderReviewAttempts(...args);
  }
  updateReminderAttemptOutcome(
    ...args: Parameters<ReminderRepository["updateReminderAttemptOutcome"]>
  ): ReturnType<ReminderRepository["updateReminderAttemptOutcome"]> {
    return this.reminders.updateReminderAttemptOutcome(...args);
  }
  createBrowserSession(
    ...args: Parameters<BrowserSessionRepository["createBrowserSession"]>
  ): ReturnType<BrowserSessionRepository["createBrowserSession"]> {
    return this.browserSessions.createBrowserSession(...args);
  }
  updateBrowserSession(
    ...args: Parameters<BrowserSessionRepository["updateBrowserSession"]>
  ): ReturnType<BrowserSessionRepository["updateBrowserSession"]> {
    return this.browserSessions.updateBrowserSession(...args);
  }
  updateBrowserSessionIfAwaitingConfirmation(
    ...args: Parameters<
      BrowserSessionRepository["updateBrowserSessionIfAwaitingConfirmation"]
    >
  ): ReturnType<
    BrowserSessionRepository["updateBrowserSessionIfAwaitingConfirmation"]
  > {
    return this.browserSessions.updateBrowserSessionIfAwaitingConfirmation(
      ...args,
    );
  }
  claimBrowserSession(
    ...args: Parameters<BrowserSessionRepository["claimBrowserSession"]>
  ): ReturnType<BrowserSessionRepository["claimBrowserSession"]> {
    return this.browserSessions.claimBrowserSession(...args);
  }
  beginBrowserSessionActionFromCompanion(
    ...args: Parameters<
      BrowserSessionRepository["beginBrowserSessionActionFromCompanion"]
    >
  ): ReturnType<
    BrowserSessionRepository["beginBrowserSessionActionFromCompanion"]
  > {
    return this.browserSessions.beginBrowserSessionActionFromCompanion(...args);
  }
  requireBrowserSessionActionConfirmation(
    ...args: Parameters<
      BrowserSessionRepository["requireBrowserSessionActionConfirmation"]
    >
  ): ReturnType<
    BrowserSessionRepository["requireBrowserSessionActionConfirmation"]
  > {
    return this.browserSessions.requireBrowserSessionActionConfirmation(
      ...args,
    );
  }
  updateBrowserSessionProgressFromCompanion(
    ...args: Parameters<
      BrowserSessionRepository["updateBrowserSessionProgressFromCompanion"]
    >
  ): ReturnType<
    BrowserSessionRepository["updateBrowserSessionProgressFromCompanion"]
  > {
    return this.browserSessions.updateBrowserSessionProgressFromCompanion(
      ...args,
    );
  }
  completeBrowserSessionFromCompanion(
    ...args: Parameters<
      BrowserSessionRepository["completeBrowserSessionFromCompanion"]
    >
  ): ReturnType<
    BrowserSessionRepository["completeBrowserSessionFromCompanion"]
  > {
    return this.browserSessions.completeBrowserSessionFromCompanion(...args);
  }
  getBrowserSession(
    ...args: Parameters<BrowserSessionRepository["getBrowserSession"]>
  ): ReturnType<BrowserSessionRepository["getBrowserSession"]> {
    return this.browserSessions.getBrowserSession(...args);
  }
  listBrowserSessions(
    ...args: Parameters<BrowserSessionRepository["listBrowserSessions"]>
  ): ReturnType<BrowserSessionRepository["listBrowserSessions"]> {
    return this.browserSessions.listBrowserSessions(...args);
  }
  getBrowserSettings(
    ...args: Parameters<BrowserCompanionRepository["getBrowserSettings"]>
  ): ReturnType<BrowserCompanionRepository["getBrowserSettings"]> {
    return this.browserCompanions.getBrowserSettings(...args);
  }
  upsertBrowserSettings(
    ...args: Parameters<BrowserCompanionRepository["upsertBrowserSettings"]>
  ): ReturnType<BrowserCompanionRepository["upsertBrowserSettings"]> {
    return this.browserCompanions.upsertBrowserSettings(...args);
  }
  getBrowserCompanionByProfile(
    ...args: Parameters<
      BrowserCompanionRepository["getBrowserCompanionByProfile"]
    >
  ): ReturnType<BrowserCompanionRepository["getBrowserCompanionByProfile"]> {
    return this.browserCompanions.getBrowserCompanionByProfile(...args);
  }
  getBrowserCompanionCredential(
    ...args: Parameters<
      BrowserCompanionRepository["getBrowserCompanionCredential"]
    >
  ): ReturnType<BrowserCompanionRepository["getBrowserCompanionCredential"]> {
    return this.browserCompanions.getBrowserCompanionCredential(...args);
  }
  upsertBrowserCompanion(
    ...args: Parameters<BrowserCompanionRepository["upsertBrowserCompanion"]>
  ): ReturnType<BrowserCompanionRepository["upsertBrowserCompanion"]> {
    return this.browserCompanions.upsertBrowserCompanion(...args);
  }
  updateBrowserCompanionPairingToken(
    ...args: Parameters<
      BrowserCompanionRepository["updateBrowserCompanionPairingToken"]
    >
  ): ReturnType<
    BrowserCompanionRepository["updateBrowserCompanionPairingToken"]
  > {
    return this.browserCompanions.updateBrowserCompanionPairingToken(...args);
  }
  updateBrowserCompanionPendingPairingTokenHashes(
    ...args: Parameters<
      BrowserCompanionRepository["updateBrowserCompanionPendingPairingTokenHashes"]
    >
  ): ReturnType<
    BrowserCompanionRepository["updateBrowserCompanionPendingPairingTokenHashes"]
  > {
    return this.browserCompanions.updateBrowserCompanionPendingPairingTokenHashes(
      ...args,
    );
  }
  promoteBrowserCompanionPendingPairingToken(
    ...args: Parameters<
      BrowserCompanionRepository["promoteBrowserCompanionPendingPairingToken"]
    >
  ): ReturnType<
    BrowserCompanionRepository["promoteBrowserCompanionPendingPairingToken"]
  > {
    return this.browserCompanions.promoteBrowserCompanionPendingPairingToken(
      ...args,
    );
  }
  revokeBrowserCompanionPairingToken(
    ...args: Parameters<
      BrowserCompanionRepository["revokeBrowserCompanionPairingToken"]
    >
  ): ReturnType<
    BrowserCompanionRepository["revokeBrowserCompanionPairingToken"]
  > {
    return this.browserCompanions.revokeBrowserCompanionPairingToken(...args);
  }
  getBrowserCompanionRevocation(
    ...args: Parameters<
      BrowserCompanionRepository["getBrowserCompanionRevocation"]
    >
  ): ReturnType<BrowserCompanionRepository["getBrowserCompanionRevocation"]> {
    return this.browserCompanions.getBrowserCompanionRevocation(...args);
  }
  revokeBrowserCompanionWithTombstone(
    ...args: Parameters<
      BrowserCompanionRepository["revokeBrowserCompanionWithTombstone"]
    >
  ): ReturnType<
    BrowserCompanionRepository["revokeBrowserCompanionWithTombstone"]
  > {
    return this.browserCompanions.revokeBrowserCompanionWithTombstone(...args);
  }
  resetBrowserCompanionRevocation(
    ...args: Parameters<
      BrowserCompanionRepository["resetBrowserCompanionRevocation"]
    >
  ): ReturnType<BrowserCompanionRepository["resetBrowserCompanionRevocation"]> {
    return this.browserCompanions.resetBrowserCompanionRevocation(...args);
  }
  listBrowserCompanions(
    ...args: Parameters<BrowserCompanionRepository["listBrowserCompanions"]>
  ): ReturnType<BrowserCompanionRepository["listBrowserCompanions"]> {
    return this.browserCompanions.listBrowserCompanions(...args);
  }
  upsertBrowserTab(
    ...args: Parameters<BrowserContextRepository["upsertBrowserTab"]>
  ): ReturnType<BrowserContextRepository["upsertBrowserTab"]> {
    return this.browserContext.upsertBrowserTab(...args);
  }
  listBrowserTabs(
    ...args: Parameters<BrowserContextRepository["listBrowserTabs"]>
  ): ReturnType<BrowserContextRepository["listBrowserTabs"]> {
    return this.browserContext.listBrowserTabs(...args);
  }
  deleteBrowserTabsByIds(
    ...args: Parameters<BrowserContextRepository["deleteBrowserTabsByIds"]>
  ): ReturnType<BrowserContextRepository["deleteBrowserTabsByIds"]> {
    return this.browserContext.deleteBrowserTabsByIds(...args);
  }
  deleteAllBrowserTabs(
    ...args: Parameters<BrowserContextRepository["deleteAllBrowserTabs"]>
  ): ReturnType<BrowserContextRepository["deleteAllBrowserTabs"]> {
    return this.browserContext.deleteAllBrowserTabs(...args);
  }
  upsertBrowserPageContext(
    ...args: Parameters<BrowserContextRepository["upsertBrowserPageContext"]>
  ): ReturnType<BrowserContextRepository["upsertBrowserPageContext"]> {
    return this.browserContext.upsertBrowserPageContext(...args);
  }
  listBrowserPageContexts(
    ...args: Parameters<BrowserContextRepository["listBrowserPageContexts"]>
  ): ReturnType<BrowserContextRepository["listBrowserPageContexts"]> {
    return this.browserContext.listBrowserPageContexts(...args);
  }
  deleteBrowserPageContextsByIds(
    ...args: Parameters<
      BrowserContextRepository["deleteBrowserPageContextsByIds"]
    >
  ): ReturnType<BrowserContextRepository["deleteBrowserPageContextsByIds"]> {
    return this.browserContext.deleteBrowserPageContextsByIds(...args);
  }
  deleteAllBrowserPageContexts(
    ...args: Parameters<
      BrowserContextRepository["deleteAllBrowserPageContexts"]
    >
  ): ReturnType<BrowserContextRepository["deleteAllBrowserPageContexts"]> {
    return this.browserContext.deleteAllBrowserPageContexts(...args);
  }
  deleteBrowserSession(
    ...args: Parameters<BrowserSessionRepository["deleteBrowserSession"]>
  ): ReturnType<BrowserSessionRepository["deleteBrowserSession"]> {
    return this.browserSessions.deleteBrowserSession(...args);
  }
  upsertEscalationState(
    ...args: Parameters<EscalationRepository["upsertEscalationState"]>
  ): ReturnType<EscalationRepository["upsertEscalationState"]> {
    return this.escalations.upsertEscalationState(...args);
  }
  getActiveEscalationState(
    ...args: Parameters<EscalationRepository["getActiveEscalationState"]>
  ): ReturnType<EscalationRepository["getActiveEscalationState"]> {
    return this.escalations.getActiveEscalationState(...args);
  }
  resolveEscalationState(
    ...args: Parameters<EscalationRepository["resolveEscalationState"]>
  ): ReturnType<EscalationRepository["resolveEscalationState"]> {
    return this.escalations.resolveEscalationState(...args);
  }
  listRecentEscalationStates(
    ...args: Parameters<EscalationRepository["listRecentEscalationStates"]>
  ): ReturnType<EscalationRepository["listRecentEscalationStates"]> {
    return this.escalations.listRecentEscalationStates(...args);
  }
  deleteAllEscalationStates(
    ...args: Parameters<EscalationRepository["deleteAllEscalationStates"]>
  ): ReturnType<EscalationRepository["deleteAllEscalationStates"]> {
    return this.escalations.deleteAllEscalationStates(...args);
  }
  logRelationshipInteraction(
    ...args: Parameters<AuditLedgerRepository["logRelationshipInteraction"]>
  ): ReturnType<AuditLedgerRepository["logRelationshipInteraction"]> {
    return this.auditLedger.logRelationshipInteraction(...args);
  }
  upsertXDm(
    ...args: Parameters<SocialCacheRepository["upsertXDm"]>
  ): ReturnType<SocialCacheRepository["upsertXDm"]> {
    return this.socialCache.upsertXDm(...args);
  }
  listXDms(
    ...args: Parameters<SocialCacheRepository["listXDms"]>
  ): ReturnType<SocialCacheRepository["listXDms"]> {
    return this.socialCache.listXDms(...args);
  }
  upsertXFeedItem(
    ...args: Parameters<SocialCacheRepository["upsertXFeedItem"]>
  ): ReturnType<SocialCacheRepository["upsertXFeedItem"]> {
    return this.socialCache.upsertXFeedItem(...args);
  }
  listXFeedItems(
    ...args: Parameters<SocialCacheRepository["listXFeedItems"]>
  ): ReturnType<SocialCacheRepository["listXFeedItems"]> {
    return this.socialCache.listXFeedItems(...args);
  }
  upsertXSyncState(
    ...args: Parameters<SocialCacheRepository["upsertXSyncState"]>
  ): ReturnType<SocialCacheRepository["upsertXSyncState"]> {
    return this.socialCache.upsertXSyncState(...args);
  }
  getXSyncState(
    ...args: Parameters<SocialCacheRepository["getXSyncState"]>
  ): ReturnType<SocialCacheRepository["getXSyncState"]> {
    return this.socialCache.getXSyncState(...args);
  }
  upsertScreenTimeSession(
    ...args: Parameters<ActivityTelemetryRepository["upsertScreenTimeSession"]>
  ): ReturnType<ActivityTelemetryRepository["upsertScreenTimeSession"]> {
    return this.activityTelemetry.upsertScreenTimeSession(...args);
  }
  getScreenTimeSession(
    ...args: Parameters<ActivityTelemetryRepository["getScreenTimeSession"]>
  ): ReturnType<ActivityTelemetryRepository["getScreenTimeSession"]> {
    return this.activityTelemetry.getScreenTimeSession(...args);
  }
  finishScreenTimeSession(
    ...args: Parameters<ActivityTelemetryRepository["finishScreenTimeSession"]>
  ): ReturnType<ActivityTelemetryRepository["finishScreenTimeSession"]> {
    return this.activityTelemetry.finishScreenTimeSession(...args);
  }
  listScreenTimeSessionsBetween(
    ...args: Parameters<
      ActivityTelemetryRepository["listScreenTimeSessionsBetween"]
    >
  ): ReturnType<ActivityTelemetryRepository["listScreenTimeSessionsBetween"]> {
    return this.activityTelemetry.listScreenTimeSessionsBetween(...args);
  }
  listScreenTimeSessionsOverlapping(
    ...args: Parameters<
      ActivityTelemetryRepository["listScreenTimeSessionsOverlapping"]
    >
  ): ReturnType<
    ActivityTelemetryRepository["listScreenTimeSessionsOverlapping"]
  > {
    return this.activityTelemetry.listScreenTimeSessionsOverlapping(...args);
  }
  upsertScreenTimeDaily(
    ...args: Parameters<ActivityTelemetryRepository["upsertScreenTimeDaily"]>
  ): ReturnType<ActivityTelemetryRepository["upsertScreenTimeDaily"]> {
    return this.activityTelemetry.upsertScreenTimeDaily(...args);
  }
  upsertScheduleInsight(
    ...args: Parameters<ScheduleProjectionRepository["upsertScheduleInsight"]>
  ): ReturnType<ScheduleProjectionRepository["upsertScheduleInsight"]> {
    return this.scheduleProjections.upsertScheduleInsight(...args);
  }
  insertTelemetryEvent(
    ...args: Parameters<ActivityTelemetryRepository["insertTelemetryEvent"]>
  ): ReturnType<ActivityTelemetryRepository["insertTelemetryEvent"]> {
    return this.activityTelemetry.insertTelemetryEvent(...args);
  }
  listTelemetryEvents(
    ...args: Parameters<ActivityTelemetryRepository["listTelemetryEvents"]>
  ): ReturnType<ActivityTelemetryRepository["listTelemetryEvents"]> {
    return this.activityTelemetry.listTelemetryEvents(...args);
  }
  pruneTelemetryEvents(
    ...args: Parameters<ActivityTelemetryRepository["pruneTelemetryEvents"]>
  ): ReturnType<ActivityTelemetryRepository["pruneTelemetryEvents"]> {
    return this.activityTelemetry.pruneTelemetryEvents(...args);
  }
  upsertTelemetryDailyRollup(
    ...args: Parameters<
      ActivityTelemetryRepository["upsertTelemetryDailyRollup"]
    >
  ): ReturnType<ActivityTelemetryRepository["upsertTelemetryDailyRollup"]> {
    return this.activityTelemetry.upsertTelemetryDailyRollup(...args);
  }
  readCircadianState(
    ...args: Parameters<ActivityTelemetryRepository["readCircadianState"]>
  ): ReturnType<ActivityTelemetryRepository["readCircadianState"]> {
    return this.activityTelemetry.readCircadianState(...args);
  }
  upsertCircadianState(
    ...args: Parameters<ActivityTelemetryRepository["upsertCircadianState"]>
  ): ReturnType<ActivityTelemetryRepository["upsertCircadianState"]> {
    return this.activityTelemetry.upsertCircadianState(...args);
  }
  upsertSleepEpisode(
    ...args: Parameters<ActivityTelemetryRepository["upsertSleepEpisode"]>
  ): ReturnType<ActivityTelemetryRepository["upsertSleepEpisode"]> {
    return this.activityTelemetry.upsertSleepEpisode(...args);
  }
  listSleepEpisodesBetween(
    ...args: Parameters<ActivityTelemetryRepository["listSleepEpisodesBetween"]>
  ): ReturnType<ActivityTelemetryRepository["listSleepEpisodesBetween"]> {
    return this.activityTelemetry.listSleepEpisodesBetween(...args);
  }
  upsertScheduleObservation(
    ...args: Parameters<
      ScheduleProjectionRepository["upsertScheduleObservation"]
    >
  ): ReturnType<ScheduleProjectionRepository["upsertScheduleObservation"]> {
    return this.scheduleProjections.upsertScheduleObservation(...args);
  }
  listScheduleObservations(
    ...args: Parameters<
      ScheduleProjectionRepository["listScheduleObservations"]
    >
  ): ReturnType<ScheduleProjectionRepository["listScheduleObservations"]> {
    return this.scheduleProjections.listScheduleObservations(...args);
  }
  upsertScheduleMergedState(
    ...args: Parameters<
      ScheduleProjectionRepository["upsertScheduleMergedState"]
    >
  ): ReturnType<ScheduleProjectionRepository["upsertScheduleMergedState"]> {
    return this.scheduleProjections.upsertScheduleMergedState(...args);
  }
  getScheduleMergedState(
    ...args: Parameters<ScheduleProjectionRepository["getScheduleMergedState"]>
  ): ReturnType<ScheduleProjectionRepository["getScheduleMergedState"]> {
    return this.scheduleProjections.getScheduleMergedState(...args);
  }
  listScreenTimeDaily(
    ...args: Parameters<ActivityTelemetryRepository["listScreenTimeDaily"]>
  ): ReturnType<ActivityTelemetryRepository["listScreenTimeDaily"]> {
    return this.activityTelemetry.listScreenTimeDaily(...args);
  }
  aggregateScreenTimeDailyForDate(
    ...args: Parameters<
      ActivityTelemetryRepository["aggregateScreenTimeDailyForDate"]
    >
  ): ReturnType<
    ActivityTelemetryRepository["aggregateScreenTimeDailyForDate"]
  > {
    return this.activityTelemetry.aggregateScreenTimeDailyForDate(...args);
  }
  upsertSchedulingNegotiation(
    ...args: Parameters<NegotiationRepository["upsertSchedulingNegotiation"]>
  ): ReturnType<NegotiationRepository["upsertSchedulingNegotiation"]> {
    return this.negotiations.upsertSchedulingNegotiation(...args);
  }
  getSchedulingNegotiation(
    ...args: Parameters<NegotiationRepository["getSchedulingNegotiation"]>
  ): ReturnType<NegotiationRepository["getSchedulingNegotiation"]> {
    return this.negotiations.getSchedulingNegotiation(...args);
  }
  listSchedulingNegotiations(
    ...args: Parameters<NegotiationRepository["listSchedulingNegotiations"]>
  ): ReturnType<NegotiationRepository["listSchedulingNegotiations"]> {
    return this.negotiations.listSchedulingNegotiations(...args);
  }
  updateSchedulingNegotiationState(
    ...args: Parameters<
      NegotiationRepository["updateSchedulingNegotiationState"]
    >
  ): ReturnType<NegotiationRepository["updateSchedulingNegotiationState"]> {
    return this.negotiations.updateSchedulingNegotiationState(...args);
  }
  upsertSchedulingProposal(
    ...args: Parameters<NegotiationRepository["upsertSchedulingProposal"]>
  ): ReturnType<NegotiationRepository["upsertSchedulingProposal"]> {
    return this.negotiations.upsertSchedulingProposal(...args);
  }
  getSchedulingProposal(
    ...args: Parameters<NegotiationRepository["getSchedulingProposal"]>
  ): ReturnType<NegotiationRepository["getSchedulingProposal"]> {
    return this.negotiations.getSchedulingProposal(...args);
  }
  listSchedulingProposals(
    ...args: Parameters<NegotiationRepository["listSchedulingProposals"]>
  ): ReturnType<NegotiationRepository["listSchedulingProposals"]> {
    return this.negotiations.listSchedulingProposals(...args);
  }
  updateSchedulingProposalStatus(
    ...args: Parameters<NegotiationRepository["updateSchedulingProposalStatus"]>
  ): ReturnType<NegotiationRepository["updateSchedulingProposalStatus"]> {
    return this.negotiations.updateSchedulingProposalStatus(...args);
  }
  upsertScheduledTask(
    ...args: Parameters<ScheduledTaskRepository["upsertScheduledTask"]>
  ): ReturnType<ScheduledTaskRepository["upsertScheduledTask"]> {
    return this.scheduledTasks.upsertScheduledTask(...args);
  }
  claimScheduledTaskForFire(
    ...args: Parameters<ScheduledTaskRepository["claimScheduledTaskForFire"]>
  ): ReturnType<ScheduledTaskRepository["claimScheduledTaskForFire"]> {
    return this.scheduledTasks.claimScheduledTaskForFire(...args);
  }
  getScheduledTask(
    ...args: Parameters<ScheduledTaskRepository["getScheduledTask"]>
  ): ReturnType<ScheduledTaskRepository["getScheduledTask"]> {
    return this.scheduledTasks.getScheduledTask(...args);
  }
  getScheduledTaskByIdempotencyKey(
    ...args: Parameters<
      ScheduledTaskRepository["getScheduledTaskByIdempotencyKey"]
    >
  ): ReturnType<ScheduledTaskRepository["getScheduledTaskByIdempotencyKey"]> {
    return this.scheduledTasks.getScheduledTaskByIdempotencyKey(...args);
  }
  listScheduledTasks(
    ...args: Parameters<ScheduledTaskRepository["listScheduledTasks"]>
  ): ReturnType<ScheduledTaskRepository["listScheduledTasks"]> {
    return this.scheduledTasks.listScheduledTasks(...args);
  }
  deleteScheduledTask(
    ...args: Parameters<ScheduledTaskRepository["deleteScheduledTask"]>
  ): ReturnType<ScheduledTaskRepository["deleteScheduledTask"]> {
    return this.scheduledTasks.deleteScheduledTask(...args);
  }
  resetSchedulingStateForScenario(
    ...args: Parameters<
      ScheduledTaskRepository["resetSchedulingStateForScenario"]
    >
  ): ReturnType<ScheduledTaskRepository["resetSchedulingStateForScenario"]> {
    return this.scheduledTasks.resetSchedulingStateForScenario(...args);
  }
  appendScheduledTaskLog(
    ...args: Parameters<ScheduledTaskRepository["appendScheduledTaskLog"]>
  ): ReturnType<ScheduledTaskRepository["appendScheduledTaskLog"]> {
    return this.scheduledTasks.appendScheduledTaskLog(...args);
  }
  listScheduledTaskLog(
    ...args: Parameters<ScheduledTaskRepository["listScheduledTaskLog"]>
  ): ReturnType<ScheduledTaskRepository["listScheduledTaskLog"]> {
    return this.scheduledTasks.listScheduledTaskLog(...args);
  }
  rollupScheduledTaskLog(
    ...args: Parameters<ScheduledTaskRepository["rollupScheduledTaskLog"]>
  ): ReturnType<ScheduledTaskRepository["rollupScheduledTaskLog"]> {
    return this.scheduledTasks.rollupScheduledTaskLog(...args);
  }
  upsertWorkThread(
    ...args: Parameters<WorkThreadRepository["upsertWorkThread"]>
  ): ReturnType<WorkThreadRepository["upsertWorkThread"]> {
    return this.workThreads.upsertWorkThread(...args);
  }
  getWorkThread(
    ...args: Parameters<WorkThreadRepository["getWorkThread"]>
  ): ReturnType<WorkThreadRepository["getWorkThread"]> {
    return this.workThreads.getWorkThread(...args);
  }
  listWorkThreads(
    ...args: Parameters<WorkThreadRepository["listWorkThreads"]>
  ): ReturnType<WorkThreadRepository["listWorkThreads"]> {
    return this.workThreads.listWorkThreads(...args);
  }
  appendWorkThreadEvent(
    ...args: Parameters<WorkThreadRepository["appendWorkThreadEvent"]>
  ): ReturnType<WorkThreadRepository["appendWorkThreadEvent"]> {
    return this.workThreads.appendWorkThreadEvent(...args);
  }
  appendWorkThreadEventTx(
    ...args: Parameters<WorkThreadRepository["appendWorkThreadEventTx"]>
  ): ReturnType<WorkThreadRepository["appendWorkThreadEventTx"]> {
    return this.workThreads.appendWorkThreadEventTx(...args);
  }
  findWorkThreadMergeEvent(
    ...args: Parameters<WorkThreadRepository["findWorkThreadMergeEvent"]>
  ): ReturnType<WorkThreadRepository["findWorkThreadMergeEvent"]> {
    return this.workThreads.findWorkThreadMergeEvent(...args);
  }
  mergeWorkThreadsAtomic(
    ...args: Parameters<WorkThreadRepository["mergeWorkThreadsAtomic"]>
  ): ReturnType<WorkThreadRepository["mergeWorkThreadsAtomic"]> {
    return this.workThreads.mergeWorkThreadsAtomic(...args);
  }
  listWorkThreadEvents(
    ...args: Parameters<WorkThreadRepository["listWorkThreadEvents"]>
  ): ReturnType<WorkThreadRepository["listWorkThreadEvents"]> {
    return this.workThreads.listWorkThreadEvents(...args);
  }
}

export function createLifeOpsGoalDefinition(
  params: Omit<LifeOpsGoalDefinition, "id" | "createdAt" | "updatedAt">,
): LifeOpsGoalDefinition {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
