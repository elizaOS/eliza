/**
 * Utility Functions Index
 *
 * Re-exports all utility functions from the engine package
 */

// Content analysis utilities
// Content safety utilities
export {
  analyzeCertainty,
  analyzeSentiment,
  type ContentCheckResult,
  calculateContentQuality,
  calculateFreshness,
  checkAgentOutput,
  checkUserInput,
  detectPrediction,
  hasInsiderLanguage,
  sanitizeContent,
} from '@feed/shared';
// Actor utilities (shared across actor-related services)
export {
  fetchRelevantPosts,
  findRelatedActorsByAffiliation,
  resolveActorName,
} from './actor-utils';
// Array utilities (safe array access)
export {
  assertNonEmpty,
  at,
  atOrThrow,
  first,
  firstOrThrow,
  isNonEmpty,
  last,
  lastOrThrow,
} from './array-utils';
// Comprehensive context builder for rich NPC context
export {
  buildComprehensiveNPCContext,
  type ComprehensiveNPCContext,
  formatComprehensiveContext,
} from './context-builder';
// Context limits and utilities
export {
  CONTEXT_LIMITS,
  estimateTokens,
  isContextSizeSafe,
  truncateArray,
  truncateText,
} from './context-limits';
// Date utilities
export {
  extractDayFromEvent,
  extractDayFromPost,
  extractDayFromTimestamp,
  getTodayDateString,
  toDateString,
} from './date-utils';
// Entropy utilities (secure random, weighted picks, cooldowns)
export {
  biasedRandomCount,
  type EventCooldownState,
  generateSentimentSignal,
  SeededRandom,
  securePickN,
  secureRandom,
  secureRandomInt,
  secureShuffle,
  shouldFireEvent,
  urgencyWeight,
  weightedPick,
} from './entropy';
// Error utilities for consistent error handling
export {
  formatError,
  formatErrorWithStack,
  handleNonCritical,
  handleNonCriticalWithDefault,
  hasErrorCode,
  isTransientError,
  logAndRethrow,
  logError,
  logWarning,
  safeExecute,
  withRetry,
} from './error-utils';
// Feed diversity utilities (TikTok-inspired clustering prevention)
export {
  ActionDiversityTracker,
  createDiscourseActionDeck,
  type DiscourseActionType,
  type EngagementActionType,
  shuffleWithNoConsecutive,
} from './feed-diversity';
// Rich game context builder for game generation prompts
export {
  buildCharacterRoster,
  buildRichGameContext,
  type CharacterRosterEntry,
  extractNarrativeThreadsWithLoopDetection,
  formatCharacterAndOrgRoster,
  formatCharacterGameContext,
  formatDaySummaries,
  formatRichGameContext,
  formatRichGameContextWithEntropy,
  generateAntiLoopContext,
  type RichGameContext,
} from './game-context-builder';
// Math utilities (clamp, lerp, etc.)
export {
  clamp,
  clamp01,
  clampPercent,
  clampSentiment,
  inRange,
  lerp,
  normalize,
  percentChange,
  roundTo,
  safeDivide,
} from './math-utils';
// Prompt logging utilities
export {
  isPromptLoggingEnabled,
  logPrompt,
  type PromptLogEntry,
} from './prompt-logger';
// Randomization utilities
export {
  pickRandom,
  type RngFunction,
  randomChance,
  randomInt,
  sampleRandom,
  shuffleArray,
} from './randomization';
// Shared utilities (formatActorVoiceContext, buildPhaseContext, etc.)
export {
  buildCharacterFeedContext,
  buildPhaseContext,
  deriveStrategyFromPersonality,
  formatActorVoiceContext,
  formatCharacterInfoWithEntropy,
  type GamePhase,
  generateBehavioralModifier,
  getPhaseForDay,
  getPhaseNarrativeGuidance,
  rateLimitedParallel,
  stripHashtagsAndEmojis,
  toQuestionIdNumberOrNull,
} from './shared-utils';
