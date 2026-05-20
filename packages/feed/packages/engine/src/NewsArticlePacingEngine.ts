/**
 * News Article Pacing Engine - Controlled Article Generation
 *
 * @module engine/NewsArticlePacingEngine
 *
 * @description
 * Controls when news organizations publish articles to prevent feed flooding.
 * Each outlet writes maximum 1 article per question per stage (breaking, commentary, resolution).
 *
 * **Pacing Strategy:**
 * - **Breaking Stage** (Question created): 1-2 outlets break the story
 * - **Commentary Stage** (Mid-question): 2-3 outlets provide analysis
 * - **Resolution Stage** (Question resolved): All major outlets cover outcome
 *
 * **Volume Control:**
 * - Normal posts: HIGH volume (hundreds per day)
 * - News articles: LOW volume (1-3 per question stage)
 * - Prevents article spam while maintaining realistic news cycle
 *
 * @example
 * ```typescript
 * const pacer = new NewsArticlePacingEngine();
 *
 * // Check if article should be generated
 * if (pacer.shouldGenerateArticle(questionId, orgId, 'breaking')) {
 *   const article = await articleGen.generateArticle(question, org);
 *   pacer.recordArticle(questionId, orgId, 'breaking');
 * }
 * ```
 */

import { logger } from "@feed/shared";
import { shuffleArray } from "./utils/randomization";

/**
 * Article generation stage in question lifecycle
 */
export type ArticleStage = "breaking" | "commentary" | "resolution";

/**
 * Arc event status - determines when an org can report again
 */
export type ArcEventStatus =
  | "created" // Arc event just created (breaking news)
  | "updated" // Significant new information added
  | "resolved"; // Arc event concluded/resolved

/** Valid arc event statuses for type guard validation */
const VALID_ARC_EVENT_STATUSES: readonly ArcEventStatus[] = [
  "created",
  "updated",
  "resolved",
] as const;

/**
 * Type guard to validate if a value is a valid ArcEventStatus
 */
export function isValidArcEventStatus(value: unknown): value is ArcEventStatus {
  return (
    typeof value === "string" &&
    VALID_ARC_EVENT_STATUSES.includes(value as ArcEventStatus)
  );
}

/**
 * Record of which orgs have published articles for which questions
 */
interface ArticleRecord {
  questionId: number;
  orgId: string;
  stage: ArticleStage;
  tick: number;
  articleId: string;
}

/**
 * Record of arc event coverage by organization
 * Once an org reports on an event's status, they cannot report again
 * until the status changes (event resolves or updates with new info)
 */
interface ArcEventCoverageRecord {
  arcEventId: string;
  orgId: string;
  lastReportedStatus: ArcEventStatus;
  articleId: string;
  timestamp: Date;
}

/**
 * News Article Pacing Engine
 *
 * @class NewsArticlePacingEngine
 *
 * @description
 * Manages article generation pacing to maintain realistic news cycles without
 * overwhelming the social feed with long-form content.
 *
 * **Rules:**
 * - Each org can publish max 1 article per question per stage
 * - Breaking stage: 1-2 random orgs (race to break the story)
 * - Commentary stage: 2-3 random orgs (mid-question analysis)
 * - Resolution stage: All major outlets (definitive coverage)
 */
export class NewsArticlePacingEngine {
  private articleRecords: ArticleRecord[] = [];
  private stageOrgCounts: Map<string, Map<string, Set<string>>> = new Map(); // questionId -> stage -> Set<orgId>

  // ARC EVENT TRACKING - event-driven articles only
  private arcEventCoverage: Map<string, Map<string, ArcEventCoverageRecord>> =
    new Map(); // arcEventId -> orgId -> coverage record

  /**
   * Check if an organization should generate an article
   *
   * @param questionId - Prediction market question ID
   * @param orgId - News organization ID
   * @param stage - Article stage (breaking/commentary/resolution)
   * @returns True if article should be generated
   *
   * @description
   * Implements pacing rules:
   * - Returns false if org already published for this question+stage
   * - For breaking: allows only first 1-2 orgs
   * - For commentary: allows only 2-3 orgs
   * - For resolution: allows all orgs (final outcome coverage)
   */
  shouldGenerateArticle(
    questionId: number,
    orgId: string,
    stage: ArticleStage,
  ): boolean {
    // Validate inputs
    if (!questionId || questionId <= 0) {
      throw new Error(`Invalid questionId: ${questionId}`);
    }
    if (!orgId || orgId.trim().length === 0) {
      throw new Error(`Invalid orgId: ${orgId}`);
    }
    if (!stage || !["breaking", "commentary", "resolution"].includes(stage)) {
      throw new Error(`Invalid stage: ${stage}`);
    }

    // Check if this org already published for this question+stage
    if (this.hasPublished(questionId, orgId, stage)) {
      logger.debug(
        `${orgId} already published ${stage} article for Q${questionId}`,
        undefined,
        "NewsArticlePacingEngine",
      );
      return false;
    }

    // Get current count for this question+stage
    const stageKey = `${questionId}:${stage}`;
    if (!this.stageOrgCounts.has(stageKey)) {
      this.stageOrgCounts.set(stageKey, new Map());
    }

    const stageMap = this.stageOrgCounts.get(stageKey)!;
    if (!stageMap.has(stage)) {
      stageMap.set(stage, new Set());
    }

    const orgsForStage = stageMap.get(stage)!;
    const currentCount = orgsForStage.size;

    // Apply stage-specific limits
    switch (stage) {
      case "breaking":
        // Only first 1-2 orgs break the story (race to publish)
        return currentCount < 2;

      case "commentary":
        // 2-3 orgs provide mid-question analysis
        return currentCount < 3;

      case "resolution":
        // All orgs can cover final outcome (major news)
        return true; // No limit for resolution coverage

      default:
        return false;
    }
  }

  /**
   * Record that an article was published
   *
   * @param questionId - Prediction market question ID
   * @param orgId - News organization ID
   * @param stage - Article stage
   * @param articleId - Generated article ID
   * @param tick - Current game tick
   */
  recordArticle(
    questionId: number,
    orgId: string,
    stage: ArticleStage,
    articleId: string,
    tick: number,
  ): void {
    // Validate all inputs
    if (!questionId || questionId <= 0) {
      throw new Error(`Invalid questionId for recordArticle: ${questionId}`);
    }
    if (!orgId || orgId.trim().length === 0) {
      throw new Error(`Invalid orgId for recordArticle: ${orgId}`);
    }
    if (!stage || !["breaking", "commentary", "resolution"].includes(stage)) {
      throw new Error(`Invalid stage for recordArticle: ${stage}`);
    }
    if (!articleId || articleId.trim().length === 0) {
      throw new Error(`Invalid articleId for recordArticle: ${articleId}`);
    }
    if (tick < 0) {
      throw new Error(`Invalid tick for recordArticle: ${tick}`);
    }

    // Record article
    this.articleRecords.push({
      questionId,
      orgId,
      stage,
      tick,
      articleId,
    });

    // Update stage counts
    const stageKey = `${questionId}:${stage}`;
    if (!this.stageOrgCounts.has(stageKey)) {
      this.stageOrgCounts.set(stageKey, new Map());
    }

    const stageMap = this.stageOrgCounts.get(stageKey)!;
    if (!stageMap.has(stage)) {
      stageMap.set(stage, new Set());
    }

    stageMap.get(stage)?.add(orgId);

    logger.debug(
      `Recorded ${stage} article for Q${questionId} by ${orgId}`,
      {
        articleId,
        tick,
      },
      "NewsArticlePacingEngine",
    );
  }

  /**
   * Check if org has already published for this question+stage
   */
  private hasPublished(
    questionId: number,
    orgId: string,
    stage: ArticleStage,
  ): boolean {
    return this.articleRecords.some(
      (r) =>
        r.questionId === questionId && r.orgId === orgId && r.stage === stage,
    );
  }

  /**
   * Get all articles for a question
   */
  getArticlesForQuestion(questionId: number): ArticleRecord[] {
    return this.articleRecords.filter((r) => r.questionId === questionId);
  }

  /**
   * Get stage statistics for a question
   */
  getStageStats(questionId: number): {
    breaking: number;
    commentary: number;
    resolution: number;
  } {
    const articles = this.getArticlesForQuestion(questionId);

    return {
      breaking: articles.filter((a) => a.stage === "breaking").length,
      commentary: articles.filter((a) => a.stage === "commentary").length,
      resolution: articles.filter((a) => a.stage === "resolution").length,
    };
  }

  /**
   * Select which orgs should publish articles this stage
   *
   * @param availableOrgs - All news organizations
   * @param questionId - Question ID
   * @param stage - Article stage
   * @returns Orgs that should publish (respects pacing rules)
   */
  selectOrgsForStage<T extends { id: string; name: string }>(
    availableOrgs: T[],
    questionId: number,
    stage: ArticleStage,
  ): T[] {
    // Validate inputs
    if (!availableOrgs || availableOrgs.length === 0) {
      throw new Error("availableOrgs cannot be empty");
    }
    if (!questionId || questionId <= 0) {
      throw new Error(
        `Invalid questionId for selectOrgsForStage: ${questionId}`,
      );
    }
    if (!stage || !["breaking", "commentary", "resolution"].includes(stage)) {
      throw new Error(`Invalid stage for selectOrgsForStage: ${stage}`);
    }

    // Validate each org has required fields
    for (const org of availableOrgs) {
      if (!org.id || org.id.trim().length === 0) {
        throw new Error(`Organization missing id: ${JSON.stringify(org)}`);
      }
      if (!org.name || org.name.trim().length === 0) {
        throw new Error(`Organization missing name: ${JSON.stringify(org)}`);
      }
    }

    // Filter to orgs that haven't published yet
    const eligibleOrgs = availableOrgs.filter((org) =>
      this.shouldGenerateArticle(questionId, org.id, stage),
    );

    if (eligibleOrgs.length === 0) {
      logger.info(
        `No eligible orgs for Q${questionId} ${stage} stage - all have published`,
        undefined,
        "NewsArticlePacingEngine",
      );
      return [];
    }

    // Select random subset based on stage
    let count: number;
    switch (stage) {
      case "breaking":
        count = 1 + Math.floor(Math.random() * 2); // 1-2 orgs
        break;
      case "commentary":
        count = 2 + Math.floor(Math.random() * 2); // 2-3 orgs
        break;
      case "resolution":
        count = Math.min(5, eligibleOrgs.length); // Up to 5 orgs
        break;
      default:
        count = 1;
    }

    // Shuffle and take N
    const shuffled = shuffleArray(eligibleOrgs);
    return shuffled.slice(0, count);
  }

  /**
   * Clear records for a question (e.g., after resolution)
   */
  clearQuestion(questionId: number): void {
    this.articleRecords = this.articleRecords.filter(
      (r) => r.questionId !== questionId,
    );

    // Clear stage counts
    const keysToDelete: string[] = [];
    for (const key of this.stageOrgCounts.keys()) {
      if (key.startsWith(`${questionId}:`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => this.stageOrgCounts.delete(key));

    logger.info(
      `Cleared article records for Q${questionId}`,
      undefined,
      "NewsArticlePacingEngine",
    );
  }

  /**
   * Get total article count
   */
  getTotalArticles(): number {
    return this.articleRecords.length;
  }

  /**
   * Get article count by stage
   */
  getArticleCountByStage(): Record<ArticleStage, number> {
    return {
      breaking: this.articleRecords.filter((r) => r.stage === "breaking")
        .length,
      commentary: this.articleRecords.filter((r) => r.stage === "commentary")
        .length,
      resolution: this.articleRecords.filter((r) => r.stage === "resolution")
        .length,
    };
  }

  // ============================================================================
  // ARC EVENT COVERAGE TRACKING
  // Articles are now event-driven: only generated when arc events occur
  // An org can only report on an arc event once per status (created/updated/resolved)
  // ============================================================================

  /**
   * Check if an organization should generate an article for an arc event
   *
   * @param arcEventId - Arc event ID
   * @param orgId - News organization ID
   * @param currentStatus - Current status of the arc event
   * @returns True if article should be generated (org hasn't reported this status yet)
   */
  shouldGenerateArcEventArticle(
    arcEventId: string,
    orgId: string,
    currentStatus: ArcEventStatus,
  ): boolean {
    // Validate inputs (consistent with shouldGenerateArticle)
    if (!arcEventId || arcEventId.trim().length === 0) {
      throw new Error(`Invalid arcEventId: ${arcEventId}`);
    }
    if (!orgId || orgId.trim().length === 0) {
      throw new Error(`Invalid orgId: ${orgId}`);
    }
    if (!isValidArcEventStatus(currentStatus)) {
      throw new Error(`Invalid currentStatus: ${currentStatus}`);
    }

    // Get coverage for this arc event
    const eventCoverage = this.arcEventCoverage.get(arcEventId);
    if (!eventCoverage) {
      // No coverage yet - org can report
      return true;
    }

    // Check if this org has already reported
    const orgCoverage = eventCoverage.get(orgId);
    if (!orgCoverage) {
      // This org hasn't reported yet - can report
      return true;
    }

    // Org has reported before - check if status has changed
    // Only report again if the event has a NEW status
    if (orgCoverage.lastReportedStatus === currentStatus) {
      logger.debug(
        `${orgId} already reported ${currentStatus} for arc event ${arcEventId}`,
        undefined,
        "NewsArticlePacingEngine",
      );
      return false;
    }

    // Status has changed - org can report again
    logger.debug(
      `${orgId} can report on arc event ${arcEventId}: status changed from ${orgCoverage.lastReportedStatus} to ${currentStatus}`,
      undefined,
      "NewsArticlePacingEngine",
    );
    return true;
  }

  /**
   * Record that an organization has covered an arc event
   *
   * @param arcEventId - Arc event ID
   * @param orgId - News organization ID
   * @param status - Status of the arc event at time of coverage
   * @param articleId - Generated article ID
   */
  recordArcEventCoverage(
    arcEventId: string,
    orgId: string,
    status: ArcEventStatus,
    articleId: string,
  ): void {
    // Validate inputs (consistent with other methods)
    if (!arcEventId || arcEventId.trim().length === 0) {
      throw new Error(
        `Invalid arcEventId for recordArcEventCoverage: ${arcEventId}`,
      );
    }
    if (!orgId || orgId.trim().length === 0) {
      throw new Error(`Invalid orgId for recordArcEventCoverage: ${orgId}`);
    }
    if (!isValidArcEventStatus(status)) {
      throw new Error(`Invalid status for recordArcEventCoverage: ${status}`);
    }
    if (!articleId || articleId.trim().length === 0) {
      throw new Error(
        `Invalid articleId for recordArcEventCoverage: ${articleId}`,
      );
    }

    // Initialize map for this arc event if needed
    if (!this.arcEventCoverage.has(arcEventId)) {
      this.arcEventCoverage.set(arcEventId, new Map());
    }

    const eventCoverage = this.arcEventCoverage.get(arcEventId)!;

    // Record/update coverage for this org
    eventCoverage.set(orgId, {
      arcEventId,
      orgId,
      lastReportedStatus: status,
      articleId,
      timestamp: new Date(),
    });

    logger.info(
      `Recorded arc event coverage: ${orgId} reported ${status} for event ${arcEventId}`,
      { articleId },
      "NewsArticlePacingEngine",
    );
  }

  /**
   * Get organizations that haven't covered an arc event at the current status
   *
   * @param arcEventId - Arc event ID
   * @param currentStatus - Current status of the arc event
   * @param availableOrgs - All news organizations
   * @param maxOrgs - Maximum number of orgs to return (default 2)
   * @returns Orgs that should publish (haven't reported this status yet)
   */
  selectOrgsForArcEvent<T extends { id: string; name: string }>(
    arcEventId: string,
    currentStatus: ArcEventStatus,
    availableOrgs: T[],
    maxOrgs: number = 2,
  ): T[] {
    // Validate inputs (consistent with selectOrgsForStage)
    if (!arcEventId || arcEventId.trim().length === 0) {
      throw new Error(
        `Invalid arcEventId for selectOrgsForArcEvent: ${arcEventId}`,
      );
    }
    if (!isValidArcEventStatus(currentStatus)) {
      throw new Error(
        `Invalid currentStatus for selectOrgsForArcEvent: ${currentStatus}`,
      );
    }
    if (!availableOrgs || availableOrgs.length === 0) {
      throw new Error("availableOrgs cannot be empty");
    }
    if (maxOrgs <= 0) {
      throw new Error(`Invalid maxOrgs: ${maxOrgs}`);
    }

    // Validate each org has required fields
    for (const org of availableOrgs) {
      if (!org.id || org.id.trim().length === 0) {
        throw new Error(`Organization missing id: ${JSON.stringify(org)}`);
      }
      if (!org.name || org.name.trim().length === 0) {
        throw new Error(`Organization missing name: ${JSON.stringify(org)}`);
      }
    }

    // Filter to orgs that haven't reported this status yet
    const eligibleOrgs = availableOrgs.filter((org) =>
      this.shouldGenerateArcEventArticle(arcEventId, org.id, currentStatus),
    );

    if (eligibleOrgs.length === 0) {
      return [];
    }

    // Shuffle and take maxOrgs
    const shuffled = shuffleArray(eligibleOrgs);
    return shuffled.slice(0, maxOrgs);
  }

  /**
   * Clear arc event coverage records (e.g., on cleanup)
   */
  clearArcEventCoverage(arcEventId: string): void {
    this.arcEventCoverage.delete(arcEventId);
    logger.info(
      `Cleared arc event coverage for ${arcEventId}`,
      undefined,
      "NewsArticlePacingEngine",
    );
  }

  /**
   * Get arc event coverage statistics
   */
  getArcEventCoverageStats(): {
    totalEvents: number;
    totalCoverage: number;
    eventIds: string[];
  } {
    const eventIds = Array.from(this.arcEventCoverage.keys());
    let totalCoverage = 0;
    for (const coverage of this.arcEventCoverage.values()) {
      totalCoverage += coverage.size;
    }
    return {
      totalEvents: eventIds.length,
      totalCoverage,
      eventIds,
    };
  }

  /**
   * Check if an event has been covered by any organization at a specific status.
   *
   * @param eventId - The arc event ID to check
   * @param status - The status to check coverage for
   * @returns True if any org has covered this event at the specified status
   */
  hasEventBeenCoveredForStatus(
    eventId: string,
    status: ArcEventStatus,
  ): boolean {
    if (!eventId || eventId.trim().length === 0) {
      throw new Error(
        `Invalid eventId for hasEventBeenCoveredForStatus: ${eventId}`,
      );
    }
    if (!isValidArcEventStatus(status)) {
      throw new Error(
        `Invalid status for hasEventBeenCoveredForStatus: ${status}`,
      );
    }

    const eventCoverage = this.arcEventCoverage.get(eventId);
    if (!eventCoverage) {
      return false;
    }

    // Check if any org has covered this event at the specified status
    for (const coverage of eventCoverage.values()) {
      if (coverage.lastReportedStatus === status) {
        return true;
      }
    }

    return false;
  }
}
