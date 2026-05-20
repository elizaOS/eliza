/**
 * Prompt Registry
 *
 * Central export for all prompt definitions across the application.
 * Provides a single import point for all prompts, enabling type safety
 * and tree-shaking. Prompts are organized by category (feed, game, image,
 * system, world, trading).
 *
 * @example
 * ```ts
 * import { ambientPost, renderPrompt } from '@feed/engine';
 *
 * const prompt = renderPrompt(ambientPost, {
 *   actorName: 'Alice',
 *   actorDescription: 'Tech CEO'
 * });
 * ```
 */

export type { PromptDefinition } from "./define-prompt";
// Re-export utilities
export { definePrompt, renderTemplate } from "./define-prompt";
export { ambientPosts } from "./feed/ambient-posts";
export { analystReaction } from "./feed/analyst-reaction";
export { commentary } from "./feed/commentary";

// Prompts by category
// Feed prompts
export { companyPost } from "./feed/company-post";
export { conspiracy } from "./feed/conspiracy";
export { governmentPost } from "./feed/government-post";
export { minuteAmbient } from "./feed/minute-ambient";
export { newsPosts } from "./feed/news-posts";
export { organicPost } from "./feed/organic-post";
export { reactions } from "./feed/reactions";
export { replies } from "./feed/replies";
export { reply } from "./feed/reply";
export { socialPost } from "./feed/social-post";
export { stockTicker } from "./feed/stock-ticker";
export { baselineEvent } from "./game/baseline-event";
export { biasedArticle } from "./game/biased-article";
export { dayEvents } from "./game/day-events";

// Game prompts
export { dayTransition } from "./game/day-transition";
export { groupChatName } from "./game/group-chat-name";
export { groupMessage } from "./game/group-message";
export { groupMessages } from "./game/group-messages";
export { phaseContext } from "./game/phase-context";
export { priceAnnouncement } from "./game/price-announcement";
export { questionGeneration } from "./game/question-generation";
export { questionRankings } from "./game/question-rankings";
export { questionResolutionValidation } from "./game/question-resolution-validation";
export { questionResolvedFeed } from "./game/question-resolved-feed";
export { questions } from "./game/questions";
export { scenarios } from "./game/scenarios";
export { trendingTopics } from "./game/trending-topics";
export { worldImpactAssessment } from "./game/world-impact";
// Image prompts
export { actorBanner, actorPortrait } from "./image/actor-portrait";
export {
  articleCover,
  getRandomTwist,
  SURREAL_TWISTS,
} from "./image/article-cover";
export {
  organizationBanner,
  organizationLogo,
} from "./image/organization-logo";
export { userProfileBanner } from "./image/user-profile-banner";
export { userProfilePicture } from "./image/user-profile-picture";
export { getPromptParams, renderPrompt } from "./loader";
// Random context for entropy in prompts
export {
  formatRandomContext,
  generateRandomMarketContext,
  type RandomMarketContext,
} from "./random-context";
// Reality grounding utilities
export { getWorldEventExamples } from "./reality-grounding";
// Shared sections utilities
export {
  ANTI_REPETITION_RULES,
  buildStandardPromptSections,
  CHARACTER_ROSTER_HEADER,
  CONTENT_REQUIREMENTS_MARKET,
  characterVoiceGuidance,
  EVENT_CONTINUITY_RULES,
  FULL_CONTEXT_HEADER,
  getTimeOfDayEnergy,
  NARRATIVE_CONTINUITY_RULES,
  NPC_POST_QUALITY_RULES,
  PARODY_NAME_RULES,
  PRIVATE_CONTENT_GUIDANCE,
  QUESTION_CONTINUITY_RULES,
  RICH_NARRATIVE_CONTEXT_HEADER,
  WORLD_CONTEXT_HEADER_MINIMAL,
} from "./shared-sections";
// System prompts
export { xmlAssistant } from "./system/json-assistant";
// Trading prompts
export {
  getShuffledExamplesText,
  npcMarketDecisions,
} from "./trading/npc-market-decisions";
// Validation utilities
export {
  CHARACTER_LIMITS,
  type ValidationResult,
  validateArticle,
  validateCharacterLimit,
  validateFeedPost,
  validateGeneratedContent,
  validateHashtags,
  validateNoEmojis,
  validateNoRealNames,
  validatePostBatch,
} from "./validate-output";
export { daySummary } from "./world/day-summary";
export { expertAnalysis } from "./world/expert-analysis";
export { newsReport } from "./world/news-report";
export { npcConversation } from "./world/npc-conversation";
// World prompts
export { rumor } from "./world/rumor";
export type { WorldContext, WorldContextOptions } from "./world-context";
// World Context & Reality Grounding
export {
  buildFilteredWorldContext,
  checkRealityGrounding,
  generateActivePredictions,
  generateCurrentMarkets,
  generateRecentTrades,
  generateWorldActors,
  generateWorldContext,
  getCurrentDateContext,
  getForbiddenRealNames,
  getFullRealityGrounding,
  getMinimalRealityGrounding,
  getParodyActorNames,
  getRealityGrounding,
} from "./world-context";

/**
 * Usage examples:
 *
 * import { ambientPost, renderPrompt } from '@feed/engine';
 *
 * const prompt = renderPrompt(ambientPost, {
 *   actorName: 'Alice',
 *   actorDescription: 'Tech CEO'
 * });
 *
 * const params = getPromptParams(ambientPost);
 * // { temperature: 0.9, maxTokens: 5000 }
 */
