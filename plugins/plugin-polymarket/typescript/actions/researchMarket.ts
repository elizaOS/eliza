/**
 * Research Market Action
 *
 * Initiates deep research on a Polymarket prediction market using OpenAI's
 * deep research capabilities. Research takes approximately 30 minutes.
 *
 * The action is asynchronous:
 * - If research exists and is valid: Returns cached results immediately
 * - If research is in progress: Returns status update
 * - If no research: Starts async research task and returns confirmation
 *
 * Use forceRefresh=true to start new research even if cached results exist.
 */

import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ResearchStorageService } from "../services/researchStorage";
import { researchMarketTemplate } from "../templates";
import { type MarketResearch, ResearchStatus } from "../types";
import {
  callLLMWithTimeout,
  isLLMError,
  sendAcknowledgement,
  sendError,
} from "../utils/llmHelpers";
import { RESEARCH_TASK_NAME } from "../workers/researchTaskWorker";

interface ResearchParams {
  marketId?: string;
  marketQuestion?: string;
  forceRefresh?: boolean;
  callbackAction?: "EVALUATE_TRADE" | "NOTIFY_ONLY";
  error?: string;
}

/**
 * Build the research prompt for a market question
 */
function buildResearchPrompt(marketQuestion: string): string {
  return `Conduct comprehensive research on this prediction market question:

"${marketQuestion}"

Research goals:
1. Gather current state and the most recent developments related to this question
2. Find historical precedents and patterns that might inform the outcome
3. Collect expert opinions, forecasts, and analysis from multiple credible sources
4. Identify key factors and variables that could influence the result
5. Note any important upcoming events or deadlines
6. Assess the reliability and potential biases of different information sources

Provide a thorough, well-sourced analysis that would help someone make an informed prediction about this market's outcome.`;
}

/**
 * Format research results for display
 */
function formatResearchResults(research: MarketResearch): string {
  const rec = research.result?.recommendation;
  const recEmoji = rec?.shouldTrade ? (rec.confidence > 80 ? "🟢" : "🟡") : "🔴";

  let text = `📊 **Research Complete: ${research.marketQuestion}**\n\n`;

  if (research.result?.summary) {
    text += `**Summary:**\n${research.result.summary}\n\n`;
  }

  if (rec) {
    text += `**Trading Recommendation:** ${recEmoji}\n`;
    text += `• Should Trade: ${rec.shouldTrade ? "Yes" : "No"}\n`;
    if (rec.direction) {
      text += `• Direction: ${rec.direction}\n`;
    }
    text += `• Confidence: ${rec.confidence}%\n`;
    text += `• Reasoning: ${rec.reasoning}\n\n`;
  }

  if (research.result?.sourcesCount) {
    text += `**Sources Analyzed:** ${research.result.sourcesCount}\n`;
  }

  if (research.completedAt) {
    text += `**Completed:** ${new Date(research.completedAt).toLocaleString()}\n`;
  }

  if (research.expiresAt) {
    text += `**Expires:** ${new Date(research.expiresAt).toLocaleString()}\n`;
  }

  return text;
}

/**
 * Format the full research report (for detailed view)
 */
function _formatFullReport(research: MarketResearch): string {
  let text = formatResearchResults(research);

  if (research.result?.text) {
    // Truncate if very long, but include substantial portion
    const reportText = research.result.text;
    const maxLength = 6000;

    if (reportText.length > maxLength) {
      text += `\n---\n\n**Full Report (truncated):**\n${reportText.substring(0, maxLength)}...\n\n[Report truncated for display]`;
    } else {
      text += `\n---\n\n**Full Report:**\n${reportText}`;
    }
  }

  if (research.result?.sources && research.result.sources.length > 0) {
    text += `\n\n**Sources:**\n`;
    research.result.sources.slice(0, 10).forEach((source, i) => {
      text += `${i + 1}. [${source.title}](${source.url})\n`;
    });
    if (research.result.sources.length > 10) {
      text += `... and ${research.result.sources.length - 10} more sources\n`;
    }
  }

  return text;
}

export const researchMarketAction: Action = {
  name: "POLYMARKET_RESEARCH_MARKET",
  similes: [
    "RESEARCH_MARKET",
    "ANALYZE_MARKET",
    "DEEP_RESEARCH",
    "INVESTIGATE_MARKET",
    "MARKET_RESEARCH",
    "RESEARCH_PREDICTION",
    "STUDY_MARKET",
    "GET_RESEARCH",
    "CHECK_RESEARCH",
  ],
  description:
    "Initiates or retrieves deep research on a Polymarket prediction market using OpenAI's deep research capabilities. Takes 20-40 minutes. Returns cached results if available, status if in progress, or starts new research. Use forceRefresh=true to force new research. Parameters: marketId (condition_id), marketQuestion (the prediction question), forceRefresh (optional boolean), callbackAction (optional: EVALUATE_TRADE or NOTIFY_ONLY).",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const openaiKey = runtime.getSetting("OPENAI_API_KEY");
    if (!openaiKey) {
      runtime.logger.warn("[researchMarketAction] OPENAI_API_KEY required for research");
      return false;
    }
    // CLOB API URL has a default fallback in initializeClobClient, so no need to check here
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const storage = new ResearchStorageService(runtime);

    // Parse parameters from LLM
    const llmResult = await callLLMWithTimeout<ResearchParams>(
      runtime,
      state,
      researchMarketTemplate,
      "researchMarketAction",
    );

    // Extract parameters from LLM result or options
    const marketId =
      llmResult && !isLLMError(llmResult) ? llmResult.marketId : (options?.marketId as string);
    const marketQuestion =
      llmResult && !isLLMError(llmResult)
        ? llmResult.marketQuestion
        : (options?.marketQuestion as string);
    const forceRefresh =
      (llmResult && !isLLMError(llmResult) ? llmResult.forceRefresh : false) ??
      (options?.forceRefresh as boolean) ??
      false;
    const callbackAction =
      (llmResult && !isLLMError(llmResult) ? llmResult.callbackAction : undefined) ??
      (options?.callbackAction as "EVALUATE_TRADE" | "NOTIFY_ONLY") ??
      "NOTIFY_ONLY";

    if (!marketId || !marketQuestion) {
      await sendError(
        callback,
        "Missing required information: market ID and question are needed",
        "Use POLYMARKET_GET_MARKETS to find a market first",
      );
      return {
        success: false,
        text: "Missing market ID or question",
        data: { error: "missing_parameters" },
      };
    }

    // Send acknowledgement
    const questionPreview =
      marketQuestion.length > 50 ? `${marketQuestion.slice(0, 50)}...` : marketQuestion;
    await sendAcknowledgement(callback, `Checking research status for market...`, {
      marketId: `${marketId.slice(0, 16)}...`,
      question: questionPreview,
      forceRefresh: forceRefresh ? "yes" : "no",
    });

    // Check existing research status
    const existingResearch = await storage.getMarketResearch(marketId);

    // CASE 1: Research completed and not expired - return cached results
    if (existingResearch?.status === ResearchStatus.COMPLETED && !forceRefresh) {
      runtime.logger.info(
        `[researchMarketAction] Returning cached research for market: ${marketId}`,
      );

      const responseText = formatResearchResults(existingResearch);
      const content: Content = {
        text: responseText,
        actions: ["POLYMARKET_RESEARCH_MARKET"],
      };

      if (callback) {
        await callback(content);
      }

      return {
        success: true,
        text: responseText,
        data: {
          status: "completed",
          marketId,
          marketQuestion,
          recommendation: existingResearch.result?.recommendation,
          cached: true,
          completedAt: existingResearch.completedAt,
          expiresAt: existingResearch.expiresAt,
        },
      };
    }

    // CASE 2: Research in progress - return status
    if (existingResearch?.status === ResearchStatus.IN_PROGRESS) {
      const elapsedMinutes = (await storage.getResearchElapsedMinutes(marketId)) ?? 0;
      const estimatedRemaining = Math.max(30 - elapsedMinutes, 5);

      const responseText =
        `⏳ **Research In Progress**\n\n` +
        `**Market:** ${marketQuestion}\n` +
        `**Started:** ${elapsedMinutes} minutes ago\n` +
        `**Task ID:** \`${existingResearch.taskId}\`\n\n` +
        `Deep research typically takes 20-40 minutes. Estimated time remaining: ~${estimatedRemaining} minutes.\n\n` +
        `I'll have comprehensive analysis including:\n` +
        `• Key facts and recent developments\n` +
        `• Expert opinions and forecasts\n` +
        `• Trading recommendation with confidence level\n\n` +
        `You'll be notified when research completes.`;

      const content: Content = {
        text: responseText,
        actions: ["POLYMARKET_RESEARCH_MARKET"],
      };

      if (callback) {
        await callback(content);
      }

      return {
        success: true,
        text: responseText,
        data: {
          status: "in_progress",
          marketId,
          marketQuestion,
          taskId: existingResearch.taskId,
          elapsedMinutes,
          estimatedRemaining,
        },
      };
    }

    // CASE 3: Research expired - inform and offer to refresh
    if (existingResearch?.status === ResearchStatus.EXPIRED && !forceRefresh) {
      const ageHours = existingResearch.completedAt
        ? Math.floor((Date.now() - existingResearch.completedAt) / 3600000)
        : 0;

      const responseText =
        `⚠️ **Research Expired**\n\n` +
        `Previous research for this market is ${ageHours} hours old and may be outdated.\n\n` +
        `**Previous Recommendation:** ${existingResearch.result?.recommendation?.shouldTrade ? "Trade" : "No Trade"} ` +
        `(${existingResearch.result?.recommendation?.confidence ?? 0}% confidence)\n\n` +
        `Would you like me to start fresh research? Use forceRefresh=true or ask me to "refresh the research".`;

      const content: Content = {
        text: responseText,
        actions: ["POLYMARKET_RESEARCH_MARKET"],
      };

      if (callback) {
        await callback(content);
      }

      return {
        success: true,
        text: responseText,
        data: {
          status: "expired",
          marketId,
          marketQuestion,
          previousRecommendation: existingResearch.result?.recommendation,
          expiredAt: existingResearch.expiresAt,
        },
      };
    }

    // CASE 4: Research failed previously - inform and offer to retry
    if (existingResearch?.status === ResearchStatus.FAILED && !forceRefresh) {
      const responseText =
        `❌ **Previous Research Failed**\n\n` +
        `Error: ${existingResearch.errorMessage ?? "Unknown error"}\n\n` +
        `Would you like me to retry the research?`;

      const content: Content = {
        text: responseText,
        actions: ["POLYMARKET_RESEARCH_MARKET"],
      };

      if (callback) {
        await callback(content);
      }

      return {
        success: false,
        text: responseText,
        data: {
          status: "failed",
          marketId,
          marketQuestion,
          error: existingResearch.errorMessage,
        },
      };
    }

    // CASE 5: No research or force refresh - start new research
    const researchPrompt = buildResearchPrompt(marketQuestion);

    runtime.logger.info(`[researchMarketAction] Starting new research for market: ${marketId}`);

    // Create the async task
    const taskId = await runtime.createTask({
      name: RESEARCH_TASK_NAME,
      description: `Deep research: ${marketQuestion.substring(0, 50)}...`,
      metadata: {
        marketId,
        marketQuestion,
        researchPrompt,
        callbackAction,
        updatedAt: Date.now(),
        createdAt: Date.now(),
      },
      tags: ["queue", "immediate"], // Execute immediately, one-time task
    });

    // Mark research as in progress
    await storage.markResearchInProgress(marketId, marketQuestion, taskId);

    const responseText =
      `🔬 **Research Started**\n\n` +
      `**Market:** ${marketQuestion}\n` +
      `**Task ID:** \`${taskId}\`\n\n` +
      `Deep research has been initiated. This typically takes 20-40 minutes.\n\n` +
      `I'll analyze hundreds of sources to provide:\n` +
      `• Current facts and recent developments\n` +
      `• Expert opinions and forecasts\n` +
      `• Historical precedents and patterns\n` +
      `• Trading recommendation with confidence level\n\n` +
      `You'll be notified when research completes. You can check status anytime by asking about this market's research.`;

    const content: Content = {
      text: responseText,
      actions: ["POLYMARKET_RESEARCH_MARKET"],
    };

    if (callback) {
      await callback(content);
    }

    return {
      success: true,
      text: responseText,
      data: {
        status: "started",
        marketId,
        marketQuestion,
        taskId,
        estimatedMinutes: 30,
      },
    };
  },

  examples: [
    // Example 1: User requests deep research on specific market
    [
      { name: "{{user1}}", content: { text: "Do deep research on the Bitcoin $100k market" } },
      {
        name: "{{user2}}",
        content: {
          text: "Starting deep research. This takes 20-40 minutes but provides comprehensive analysis from hundreds of sources.",
          action: "POLYMARKET_RESEARCH_MARKET",
        },
      },
    ],
    // Example 2: Multi-turn - user considering a trade wants research first
    [
      {
        name: "{{user1}}",
        content: { text: "I'm thinking about betting on the Fed rate decision" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That's a significant market. Would you like me to do deep research on it first, or just show you the current pricing?",
        },
      },
      {
        name: "{{user1}}",
        content: { text: "Yes do the research, I want to understand all the factors" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Starting comprehensive research on the Fed rate decision market. I'll analyze economic data, Fed communications, and expert predictions.",
          action: "POLYMARKET_RESEARCH_MARKET",
        },
      },
    ],
    // Example 3: User just wants prices - should NOT do research
    [
      { name: "{{user1}}", content: { text: "What's the current price on the Trump market?" } },
      {
        name: "{{user2}}",
        content: { text: "Let me fetch the current pricing.", action: "POLYMARKET_GET_TOKEN_INFO" },
      },
    ],
    // Example 4: Check research status
    [
      { name: "{{user1}}", content: { text: "Is the research on the election market done yet?" } },
      {
        name: "{{user2}}",
        content: {
          text: "Let me check the research status.",
          action: "POLYMARKET_RESEARCH_MARKET",
        },
      },
    ],
    // Example 5: User wants to browse markets - should NOT do research
    [
      { name: "{{user1}}", content: { text: "What markets are available about AI?" } },
      {
        name: "{{user2}}",
        content: {
          text: "I'll search for AI-related prediction markets.",
          action: "POLYMARKET_GET_MARKETS",
        },
      },
    ],
    // Example 6: Force refresh existing research
    [
      {
        name: "{{user1}}",
        content: { text: "The election research is from last week, can you update it?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll refresh the research with the latest information.",
          action: "POLYMARKET_RESEARCH_MARKET",
        },
      },
    ],
  ],
};

export default researchMarketAction;
