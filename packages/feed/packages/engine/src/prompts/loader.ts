/**
 * Prompt Loader Utility
 *
 * Simplified TypeScript-based prompt system for rendering prompts with
 * variable substitution. No bundling required - works natively in Vercel
 * serverless environments.
 */

import type { JsonValue } from "../types/common";
import { toDateString } from "../utils/date-utils";
import type { PromptDefinition } from "./define-prompt";

/**
 * Render a prompt template with variable substitution.
 *
 * Replaces {{variable}} placeholders in the prompt template with actual
 * values from the variables object. Validates that required variables
 * are present and non-empty (unless marked as optional).
 *
 * @param prompt - Prompt definition to render
 * @param variables - Variables to substitute in template (key-value pairs)
 * @param options - Rendering options:
 *   - `allowEmpty`: If true, allows empty string values for variables
 *   - `optionalVars`: List of variable names that are allowed to be empty
 * @returns Rendered prompt string with all variables substituted
 * @throws Error if required variables are missing or empty
 *
 * @example
 * ```ts
 * const rendered = renderPrompt(ambientPost, {
 *   actorName: 'Alice',
 *   day: 5,
 *   worldActors: '...'
 * });
 * ```
 */
export function renderPrompt(
  prompt: PromptDefinition,
  variables: Record<string, JsonValue> = {},
  options: {
    /**
     * If true, allows empty string values for variables.
     * If false (default), throws on empty/undefined required variables.
     */
    allowEmpty?: boolean;
    /**
     * List of variable names that are allowed to be empty.
     * Useful for optional contextual data like trendContext.
     */
    optionalVars?: string[];
  } = {},
): string {
  const {
    allowEmpty = false,
    optionalVars = [
      // Trading vars (New - PR #2)
      "marketTable",
      "npcsList",
      "validNpcIds",
      "validTickers",
      "previousTrades",
      "marketSignalAnalysis",

      // Actor-specific context vars
      "antiRepetitionContext",
      "actorRules",

      // Standard context vars
      "trendContext",
      "previousPostsContext",
      "worldActors",
      "currentMarkets",
      "activePredictions",
      "recentTrades",
      "realityGrounding",
      "worldFacts",
      "worldEventExamples",
      "currentDateTime",
      "currentDate",
      "currentTime",
      "currentYear",
      "currentMonth",
      "currentDay",
      "examples",
      "contextInfo",
      "relatedQuestionContext",
      "atmosphereContext",
      "emotionalContext",

      // Character roster vars (optional until callers are updated)
      "characterRoster",
      "detailedCharacterProfiles",
      "characterRelationships",
      "organizationRoster",
      "keyActorProfiles",
      "expertProfile",
      "expertRelationships",
      "journalistProfile",
      "participantProfiles",
      "rumorTargetProfiles",
      "originalAuthorProfile",
      "involvedCharacterProfiles",
      "affectedCharacterProfiles",

      // Rich game context vars (optional)
      "richGameContext",
      "eventTimeline",
      "resolvedQuestionsContext",
      "activeQuestionsContext",
      "ongoingNarrativesContext",
      "feedActivityContext",
      "worldFactsContext",
      "phaseContext",
      "phaseGuidance",
      "daySummaries",
      "previousDaySummaries",
      "ongoingNarratives",
      "previousGroupMessages",
      "previousCoverage",
      "previousRumors",
      "participantHistory",
      "expertPreviousStatements",
      "relatedResolutions",
      "threadHistory",
      "previousRepliesContext",
      "connectionContext",
      "groupContext",
      "relationshipContext",

      // News post vars (optional - may be empty when no source)
      "sourceContext",
      "outcomeFrame",
      "orgBehaviorContext",
      "relatedStories",
      "relatedQuestions",
      "connectedActors",

      // Article generation vars (optional - worldContext may not always be available)
      "worldContext",
      "previousArticles",
      "connectedNarratives",
      "editorialPosition",
      "previousStances",
      "recentContext",

      // Day transition vars (optional - enrichment context for day summaries)
      "previousDay",
      "yesterdayHighlights",
      "yesterdayResolutions",

      // Feed character context vars (optional - enrichment when available)
      "characterEventHistory",
      "characterEventRelation",
      "involvedActors",
      "relatedNarrative",
      "relatedNarratives",
      "similarPreviousEvents",
      "previousReplies",

      // Organization context vars (optional - may not be available for all callers)
      "companyNarrativePosition",
      "previousStatements",
      "agencyActions",
      "organizationBehaviorContext",

      // Analyst/stock context vars (optional - enrichment when available)
      "analystTrackRecord",
      "previousCalls",
      "relatedEvents",
      "eventCatalyst",
      "connectedNarrative",
      "recentMarketEvents",
      "recentEventsContext",

      // Scenario/trending vars (optional - enrichment context)
      "previousScenarios",
      "previousTrends",

      // Phase context (optional - may not be set in all code paths)
      "currentPhase",

      // Group chat vars (optional - singular group-message prompt may be called with minimal context)
      "conversationHistory",
      "mood",
      "groupMembers",
      "currentPositions",
      "marketConditions",
      "informationHint",

      // Group messages batch (optional - voice reference built at call site)
      "actorVoiceReference",

      // Organic/ambient post context vars (optional - may not always have running bits)
      "runningBitContext",
      "domainContext",
      "domainHints",
      "timeEnergy",
      "targetRecentActivity",
    ],
  } = options;

  let rendered = prompt.template;

  // Inject current date/time variables
  const now = new Date();
  const dateVariables: Record<string, string | number> = {
    currentDateTime: now.toLocaleString("en-US"),
    currentDate: toDateString(now),
    currentTime: now.toTimeString().split(" ")[0] || "",
    currentYear: now.getFullYear(),
    currentMonth: now.toLocaleString("en-US", { month: "long" }),
    currentDay: now.getDate(),
  };

  const allVariables = { ...dateVariables, ...variables };

  for (const [key, value] of Object.entries(allVariables)) {
    const stringValue = String(value ?? "");

    // Validate non-optional variables are not empty
    if (!allowEmpty && !optionalVars.includes(key)) {
      if (value === undefined || value === null) {
        throw new Error(
          `Required variable "${key}" is undefined/null in prompt "${prompt.id}"`,
        );
      }
      if (typeof value === "string" && value.trim().length === 0) {
        throw new Error(
          `Required variable "${key}" is empty string in prompt "${prompt.id}"`,
        );
      }
    }

    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    rendered = rendered.replace(pattern, stringValue);
  }

  // Replace any remaining unpopulated optional vars with empty string
  for (const optVar of optionalVars) {
    const pattern = new RegExp(`\\{\\{${optVar}\\}\\}`, "g");
    rendered = rendered.replace(pattern, "");
  }

  return rendered;
}

/**
 * Get LLM parameters from a prompt definition.
 *
 * Extracts temperature and maxTokens settings from a prompt definition
 * for use in LLM API calls. Returns undefined for values that aren't set.
 *
 * @param prompt - Prompt definition to extract parameters from
 * @returns Object with temperature and maxTokens (may be undefined)
 *
 * @example
 * ```ts
 * const params = getPromptParams(ambientPost);
 * // { temperature: 0.9, maxTokens: 5000 }
 *
 * await callLLM({
 *   ...params,
 *   prompt: renderedPrompt
 * });
 * ```
 */
export function getPromptParams(prompt: PromptDefinition): {
  temperature?: number;
  maxTokens?: number;
  format?: "xml" | "json";
  promptType?: string;
  promptTemplate?: string;
} {
  return {
    temperature: prompt.temperature,
    maxTokens: prompt.maxTokens,
    format: "xml", // All our prompts use XML
    promptType: prompt.id,
    promptTemplate: prompt.template,
  };
}
