/**
 * Agent Decision Maker
 *
 * Uses LLM (Groq, Claude, or OpenAI) to make autonomous decisions based on context
 * Falls back through providers in order: Groq -> Claude -> OpenAI
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { A2APerpPosition } from "@feed/a2a";
import type { JsonValue } from "@feed/shared";
import { generateText, type LanguageModel } from "ai";
import type { MemoryEntry } from "./memory";

export interface PredictionMarket {
  id?: string;
  question: string;
  yesShares: number;
  noShares: number;
}

export interface PerpMarket {
  ticker?: string;
  name: string;
  currentPrice: number;
}

export interface FeedPost {
  id?: string;
  content: string;
  authorId?: string;
}

export interface DecisionContext {
  portfolio: { balance: number; positions: A2APerpPosition[]; pnl: number };
  markets: { predictions: PredictionMarket[]; perps: PerpMarket[] };
  feed: { posts: FeedPost[] };
  memory: MemoryEntry[];
}

export interface Decision {
  action:
    | "BUY_YES"
    | "BUY_NO"
    | "SELL"
    | "OPEN_LONG"
    | "OPEN_SHORT"
    | "CLOSE_POSITION"
    | "CREATE_POST"
    | "CREATE_COMMENT"
    | "HOLD";
  params?: Record<string, JsonValue>;
  reasoning?: string;
}

type Strategy = "conservative" | "balanced" | "aggressive" | "social";

export interface DecisionMakerConfig {
  strategy: Strategy;
  groqApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

const STRATEGY_INSTRUCTIONS: Record<Strategy, string> = {
  conservative:
    "Only trade with high confidence. Prefer holding cash. Risk tolerance: Low.",
  balanced:
    "Balance risk and reward. Trade moderately. Risk tolerance: Medium.",
  aggressive: "Seek maximum returns. Trade actively. Risk tolerance: High.",
  social:
    "Focus on social engagement. Post and comment frequently. Trade occasionally.",
} as const;

const MAX_DISPLAY_ITEMS = 3;
const MAX_CONTENT_LENGTH = 80;
const MAX_RESULT_LENGTH = 60;

export class AgentDecisionMaker {
  private config: DecisionMakerConfig;
  private model: LanguageModel;
  private providerName: string;

  constructor(config: DecisionMakerConfig) {
    this.config = config;

    // Initialize provider in order: Groq -> Claude -> OpenAI
    if (config.groqApiKey) {
      const groq = createGroq({ apiKey: config.groqApiKey });
      this.model = groq("llama-3.1-8b-instant"); // Free tier: Fast and efficient
      this.providerName = "Groq (llama-3.1-8b-instant)";
    } else if (config.anthropicApiKey) {
      const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
      this.model = anthropic("claude-sonnet-4-5");
      this.providerName = "Claude (claude-sonnet-4-5)";
    } else if (config.openaiApiKey) {
      const openai = createOpenAI({ apiKey: config.openaiApiKey });
      this.model = openai("gpt-5.1");
      this.providerName = "OpenAI (gpt-5.1)";
    } else {
      throw new Error(
        "At least one LLM API key is required (GROQ_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)",
      );
    }

    console.log(`🤖 Using LLM provider: ${this.providerName}`);
  }

  /**
   * Get the current provider name
   */
  getProvider(): string {
    return this.providerName;
  }

  /**
   * Make decision based on current context
   */
  async decide(context: DecisionContext): Promise<Decision> {
    const prompt = this.buildPrompt(context);

    const { text } = await generateText({
      model: this.model,
      prompt,
      temperature: 0.7,
      maxOutputTokens: 1000,
    });

    return this.parseDecision(text);
  }

  /**
   * Build prompt for LLM
   */
  private buildPrompt(context: DecisionContext): string {
    const formatPredictionMarket = (m: PredictionMarket) => {
      const total = m.yesShares + m.noShares;
      const yesPercent =
        total > 0 ? ((m.yesShares / total) * 100).toFixed(0) : "50";
      return `- "${m.question}" (YES: ${yesPercent}%)`;
    };

    const formatPerpMarket = (p: PerpMarket) =>
      `- ${p.name} @ $${p.currentPrice}`;

    const formatPost = (p: FeedPost) =>
      `- "${p.content.substring(0, MAX_CONTENT_LENGTH)}..."`;

    const formatMemory = (m: MemoryEntry) =>
      `- ${m.action}: ${JSON.stringify(m.result).substring(0, MAX_RESULT_LENGTH)}`;

    return `You are an autonomous trading agent for Feed prediction markets.

Strategy: ${this.config.strategy}
${STRATEGY_INSTRUCTIONS[this.config.strategy]}

Current Portfolio:
- Balance: $${context.portfolio.balance}
- Open Positions: ${context.portfolio.positions.length}
- P&L: $${context.portfolio.pnl}

Available Prediction Markets (top ${MAX_DISPLAY_ITEMS}):
${context.markets.predictions.slice(0, MAX_DISPLAY_ITEMS).map(formatPredictionMarket).join("\n") || "None"}

Available Perp Markets (top ${MAX_DISPLAY_ITEMS}):
${context.markets.perps.slice(0, MAX_DISPLAY_ITEMS).map(formatPerpMarket).join("\n") || "None"}

Recent Feed Activity:
${context.feed.posts.slice(0, MAX_DISPLAY_ITEMS).map(formatPost).join("\n") || "None"}

Recent Memory (last ${MAX_DISPLAY_ITEMS} actions):
${context.memory.map(formatMemory).join("\n") || "No recent actions"}

Decision Task:
Analyze the above context and decide what action to take this tick.

Respond in JSON format:
{
  "action": "BUY_YES" | "BUY_NO" | "SELL" | "OPEN_LONG" | "OPEN_SHORT" | "CLOSE_POSITION" | "CREATE_POST" | "CREATE_COMMENT" | "HOLD",
  "params": {
    "marketId": "...",
    "amount": 50,
    "content": "...",
    etc.
  },
  "reasoning": "Brief explanation of why"
}

Examples:
- If you see underpriced opportunity: {"action": "BUY_YES", "params": {"marketId": "...", "amount": 50}, "reasoning": "YES undervalued at 35%"}
- If no good opportunities: {"action": "HOLD", "reasoning": "No clear opportunities"}
- If social strategy: {"action": "CREATE_POST", "params": {"content": "..."}, "reasoning": "Share market insights"}

Your decision (JSON only):`;
  }

  /**
   * Parse LLM response into Decision
   */
  private parseDecision(text: string): Decision {
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in LLM response");
    }

    const decision = JSON.parse(jsonMatch[0]);
    return {
      action: decision.action || "HOLD",
      params: decision.params,
      reasoning: decision.reasoning,
    };
  }
}
