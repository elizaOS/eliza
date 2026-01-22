/**
 * Research Task Worker
 *
 * Handles asynchronous deep research tasks for Polymarket markets.
 * This worker is called by the TaskService when a research task is ready to execute.
 *
 * The research process:
 * 1. Calls OpenAI's deep research model (takes ~30 minutes)
 * 2. Generates a trading recommendation summary
 * 3. Stores results in ResearchStorageService
 * 4. Optionally triggers a follow-up trade evaluation task
 */

import type { IAgentRuntime, Task, TaskWorker } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { ResearchStorageService } from "../services/researchStorage";
import type { ResearchRecommendation, ResearchResult, ResearchTaskMetadata } from "../types";

/**
 * Response structure from the RESEARCH model
 */
interface ResearchModelResult {
  id: string;
  text: string;
  annotations: Array<{
    url: string;
    title: string;
    startIndex?: number;
    endIndex?: number;
  }>;
  outputItems?: Array<{
    type: string;
    [key: string]: unknown;
  }>;
  status?: string;
}

/** Task name for market research */
export const RESEARCH_TASK_NAME = "POLYMARKET_MARKET_RESEARCH";

/** Task name for trade evaluation after research */
export const TRADE_EVALUATION_TASK_NAME = "POLYMARKET_EVALUATE_TRADE";

/**
 * Generate a trading summary and recommendation from research text
 */
async function generateTradingSummary(
  runtime: IAgentRuntime,
  marketQuestion: string,
  researchText: string,
): Promise<{
  summary: string;
  recommendation: ResearchRecommendation;
}> {
  const prompt = `You are analyzing deep research about a prediction market to provide a trading recommendation.

**Market Question:** "${marketQuestion}"

**Research Report:**
${researchText.substring(0, 12000)}

Based on this research, provide a JSON response with exactly this structure:
{
  "summary": "A 2-3 sentence summary of the key findings that are relevant to predicting the outcome",
  "recommendation": {
    "shouldTrade": true or false,
    "direction": "YES" or "NO" (which outcome to bet on, only if shouldTrade is true),
    "confidence": 0-100 (how confident you are in this recommendation),
    "reasoning": "Brief 1-2 sentence explanation of why you recommend this position or why not to trade"
  }
}

Consider:
- Is there a clear information edge from the research?
- Is the current market likely mispriced based on these findings?
- Are there significant risks or uncertainties?
- Only recommend trading if confidence is reasonably high (>60%) and there's actionable insight.`;

  try {
    const result = (await runtime.useModel("OBJECT_LARGE" as "OBJECT_LARGE", {
      prompt,
    })) as {
      summary: string;
      recommendation: ResearchRecommendation;
    };

    // Validate and provide defaults
    return {
      summary: result.summary ?? "Research completed but summary generation failed.",
      recommendation: {
        shouldTrade: result.recommendation?.shouldTrade ?? false,
        direction: result.recommendation?.direction,
        confidence: result.recommendation?.confidence ?? 0,
        reasoning: result.recommendation?.reasoning ?? "Unable to generate reasoning.",
      },
    };
  } catch (error) {
    logger.error("[ResearchTask] Failed to generate trading summary:", error);
    return {
      summary: "Research completed but summary generation failed.",
      recommendation: {
        shouldTrade: false,
        confidence: 0,
        reasoning: "Failed to analyze research results.",
      },
    };
  }
}

/**
 * Trigger a trade evaluation task after research completes
 */
async function triggerTradeEvaluation(
  runtime: IAgentRuntime,
  metadata: ResearchTaskMetadata,
  recommendation: ResearchRecommendation,
): Promise<void> {
  if (!recommendation.shouldTrade || recommendation.confidence < 70) {
    logger.info(
      `[ResearchTask] Not triggering trade - shouldTrade: ${recommendation.shouldTrade}, confidence: ${recommendation.confidence}`,
    );
    return;
  }

  if (!metadata.tradeParams?.tokenId) {
    logger.warn("[ResearchTask] Cannot trigger trade evaluation - no tokenId provided");
    return;
  }

  logger.info(`[ResearchTask] Triggering trade evaluation for market: ${metadata.marketId}`);

  await runtime.createTask({
    name: TRADE_EVALUATION_TASK_NAME,
    description: `Evaluate trade opportunity: ${metadata.marketQuestion.substring(0, 50)}...`,
    metadata: {
      marketId: metadata.marketId,
      marketQuestion: metadata.marketQuestion,
      tokenId: metadata.tradeParams.tokenId,
      maxSize: metadata.tradeParams.maxSize,
      roomId: metadata.tradeParams.roomId,
      recommendation,
      researchCompleted: true,
      updatedAt: Date.now(),
      createdAt: Date.now(),
    },
    tags: ["queue", "immediate"],
  });
}

/**
 * Log/notify that research has completed
 */
async function notifyResearchComplete(
  _runtime: IAgentRuntime,
  metadata: ResearchTaskMetadata,
  summary: string,
  recommendation: ResearchRecommendation,
): Promise<void> {
  const direction = recommendation.direction ?? "N/A";
  const tradeStr = recommendation.shouldTrade ? `TRADE ${direction}` : "NO TRADE";

  logger.info(
    `[ResearchTask] ✅ Research completed for market: ${metadata.marketQuestion}\n` +
      `  Summary: ${summary.substring(0, 100)}...\n` +
      `  Recommendation: ${tradeStr} (${recommendation.confidence}% confidence)\n` +
      `  Reasoning: ${recommendation.reasoning}`,
  );

  // Note: Custom events could be emitted here if the event system is extended
  // For now, we rely on the task completion and storage updates
}

/**
 * The research task worker implementation
 */
export const researchTaskWorker: TaskWorker = {
  name: RESEARCH_TASK_NAME,

  /**
   * Validate that we can execute research
   */
  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    // Check if OpenAI API is configured for research
    const apiKey = runtime.getSetting("OPENAI_API_KEY");
    if (!apiKey) {
      logger.warn("[ResearchTask] OPENAI_API_KEY not configured - research unavailable");
      return false;
    }
    return true;
  },

  /**
   * Execute the research task
   */
  execute: async (
    runtime: IAgentRuntime,
    _options: Record<string, unknown>,
    task: Task,
  ): Promise<void> => {
    const metadata = task.metadata as unknown as ResearchTaskMetadata;
    const storage = new ResearchStorageService(runtime);

    logger.info(`[ResearchTask] 🔬 Starting deep research for market: ${metadata.marketQuestion}`);
    logger.info(`[ResearchTask] This may take 20-40 minutes. Task ID: ${task.id}`);

    try {
      // Call OpenAI Deep Research via the model system
      const researchParams = {
        input: metadata.researchPrompt,
        tools: [{ type: "web_search_preview" }],
        instructions: `You are a prediction market research analyst. Your job is to thoroughly research this market question and provide comprehensive analysis to help make an informed trading decision.

Focus on:
1. Current facts and recent developments directly relevant to the question
2. Expert opinions, forecasts, and analysis from credible sources
3. Historical precedents and patterns that might inform the outcome
4. Key factors and variables that could influence the result
5. Timeline considerations and important upcoming events
6. Potential biases or information gaps to be aware of

Market Question: ${metadata.marketQuestion}

Provide a detailed, balanced analysis with citations to your sources.`,
        background: true, // Use background mode for long-running tasks
      };

      logger.debug("[ResearchTask] Calling OpenAI RESEARCH model...");

      // Use "RESEARCH" as the model type string to access deep research capabilities
      // The RESEARCH model type may not be available in all environments
      // Using type assertion as the model registration happens at runtime via OpenAI plugin
      const rawResult = await (
        runtime.useModel as (modelType: string, params: Record<string, unknown>) => Promise<unknown>
      )("RESEARCH", researchParams);
      const researchResult = rawResult as ResearchModelResult;

      logger.info(
        `[ResearchTask] Research API returned. Processing ${researchResult.text.length} characters...`,
      );

      // Generate a trading recommendation summary
      const { summary, recommendation } = await generateTradingSummary(
        runtime,
        metadata.marketQuestion,
        researchResult.text,
      );

      // Build the result object
      const result: ResearchResult = {
        text: researchResult.text,
        summary,
        recommendation,
        sources: researchResult.annotations.map((a) => ({
          url: a.url,
          title: a.title,
        })),
        sourcesCount:
          researchResult.outputItems?.filter((o) => o.type === "web_search_call").length ??
          researchResult.annotations.length,
      };

      // Store the results
      await storage.storeResearchResult(metadata.marketId, result, researchResult.id);

      logger.info(`[ResearchTask] ✅ Research stored for market: ${metadata.marketId}`);

      // Handle callback action
      if (metadata.callbackAction === "EVALUATE_TRADE" && metadata.tradeParams) {
        await triggerTradeEvaluation(runtime, metadata, recommendation);
      }

      // Always notify/log completion
      await notifyResearchComplete(runtime, metadata, summary, recommendation);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[ResearchTask] ❌ Research failed: ${errorMessage}`);

      // Mark as failed in storage
      await storage.markResearchFailed(metadata.marketId, errorMessage);
    }
  },
};

export default researchTaskWorker;
