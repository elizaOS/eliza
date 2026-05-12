import { calculateCost, estimateRequestCost, normalizeModelName } from "@/lib/pricing";
import { PLATFORM_MARKUP_MULTIPLIER } from "@/lib/pricing-constants";
import { apiKeysService } from "@/lib/services/api-keys";
import {
  type CreditReservation,
  creditsService,
  InsufficientCreditsError,
} from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { logger } from "@/lib/utils/logger";

export interface HostedSearchOptions {
  query: string;
  maxResults?: number;
  model?: string;
  googleApiKey?: string;
  source?: string;
  topic?: "general" | "finance";
  timeRange?: "day" | "week" | "month" | "year" | "d" | "w" | "m" | "y";
  startDate?: string;
  endDate?: string;
}

export interface HostedSearchAuthContext {
  organizationId?: string;
  userId?: string;
  apiKey?: string | null;
  apiKeyId?: string | null;
  requestSource?: "action" | "api" | "mcp" | "a2a";
}

export interface HostedSearchResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface HostedSearchUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface HostedSearchResult {
  answer: string;
  model: string;
  provider: "google";
  query: string;
  responseTime: number;
  results: HostedSearchResultItem[];
  searchQueries: string[];
  usage: HostedSearchUsage;
  cost: number;
}

interface GoogleSearchResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
      groundingSupports?: Array<{
        segment?: {
          text?: string;
        };
        groundingChunkIndices?: number[];
        confidenceScores?: number[];
      }>;
      webSearchQueries?: string[];
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: {
    message?: string;
  };
}

const DEFAULT_SEARCH_MODEL = "google/gemini-2.5-flash";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_024;
const GOOGLE_GROUNDED_PROMPT_BASE_COST = 0.035;
const GOOGLE_GROUNDED_PROMPT_COST =
  Math.round(GOOGLE_GROUNDED_PROMPT_BASE_COST * PLATFORM_MARKUP_MULTIPLIER * 1_000_000) / 1_000_000;

function resolveGoogleSearchApiKey(override?: string): string | null {
  const candidates = [
    override,
    process.env.GOOGLE_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function normalizeTimeRange(
  range: HostedSearchOptions["timeRange"],
): "day" | "week" | "month" | "year" | null {
  if (!range) return null;
  if (range === "d") return "day";
  if (range === "w") return "week";
  if (range === "m") return "month";
  if (range === "y") return "year";
  return range;
}

function buildSearchPrompt(options: HostedSearchOptions): string {
  const hints: string[] = [];

  if (options.source?.trim()) {
    hints.push(
      `Prefer sources from ${options.source.trim()} and use site:${options.source.trim()} when useful.`,
    );
  }

  if (options.topic === "finance") {
    hints.push("Focus on finance, crypto, and market-relevant context.");
  }

  const normalizedRange = normalizeTimeRange(options.timeRange);
  if (normalizedRange) {
    hints.push(`Prefer coverage from the last ${normalizedRange}.`);
  }

  if (options.startDate && options.endDate) {
    hints.push(`Prefer sources published between ${options.startDate} and ${options.endDate}.`);
  } else if (options.startDate) {
    hints.push(`Prefer sources published on or after ${options.startDate}.`);
  } else if (options.endDate) {
    hints.push(`Prefer sources published on or before ${options.endDate}.`);
  }

  const promptLines = [
    "Search the web using Google Search grounding and answer the request with factual, source-backed information.",
    `User query: ${options.query.trim()}`,
    hints.length > 0 ? `Search guidance: ${hints.join(" ")}` : null,
    `Return a concise answer and ground it in current web sources. Limit the answer to what can be supported by search results.`,
  ];

  return promptLines.filter(Boolean).join("\n\n");
}

function extractAnswer(response: GoogleSearchResponse): string {
  return (
    response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text?.trim())
      .filter((value): value is string => Boolean(value))
      .join("\n\n") ?? ""
  ).trim();
}

function buildSearchResults(
  response: GoogleSearchResponse,
  maxResults: number,
): HostedSearchResultItem[] {
  const grounding = response.candidates?.[0]?.groundingMetadata;
  const chunks = grounding?.groundingChunks ?? [];
  const supports = grounding?.groundingSupports ?? [];
  const byUrl = new Map<
    string,
    {
      title: string;
      content: string[];
      scores: number[];
    }
  >();

  for (const support of supports) {
    const snippet = support.segment?.text?.trim();
    const scores = support.confidenceScores ?? [];
    for (const index of support.groundingChunkIndices ?? []) {
      const chunk = chunks[index];
      const url = chunk?.web?.uri?.trim();
      if (!url) {
        continue;
      }

      const current = byUrl.get(url) ?? {
        title: chunk?.web?.title?.trim() || url,
        content: [],
        scores: [],
      };

      if (snippet && !current.content.includes(snippet)) {
        current.content.push(snippet);
      }

      for (const score of scores) {
        if (typeof score === "number" && Number.isFinite(score)) {
          current.scores.push(score);
        }
      }

      byUrl.set(url, current);
    }
  }

  for (const chunk of chunks) {
    const url = chunk?.web?.uri?.trim();
    if (!url || byUrl.has(url)) {
      continue;
    }

    byUrl.set(url, {
      title: chunk?.web?.title?.trim() || url,
      content: [],
      scores: [],
    });
  }

  return Array.from(byUrl.entries())
    .map(([url, value]) => ({
      title: value.title,
      url,
      content: value.content.join(" ").trim(),
      score:
        value.scores.length > 0
          ? value.scores.reduce((total, score) => total + score, 0) / value.scores.length
          : 1,
    }))
    .slice(0, maxResults);
}

function buildSearchQueries(response: GoogleSearchResponse): string[] {
  const queries = response.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];
  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
}

async function resolveApiKeyId(auth: HostedSearchAuthContext | undefined): Promise<string | null> {
  if (auth?.apiKeyId) {
    return auth.apiKeyId;
  }

  if (!auth?.apiKey) {
    return null;
  }

  const apiKey = await apiKeysService.validateApiKey(auth.apiKey);
  return apiKey?.id ?? null;
}

function buildUsage(response: GoogleSearchResponse): HostedSearchUsage {
  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
  const totalTokens = response.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

export async function executeHostedGoogleSearch(
  options: HostedSearchOptions,
  auth?: HostedSearchAuthContext,
): Promise<HostedSearchResult> {
  const apiKey = resolveGoogleSearchApiKey(options.googleApiKey);
  if (!apiKey) {
    throw new Error(
      "GOOGLE_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY is not configured",
    );
  }

  const query = options.query?.trim();
  if (!query) {
    throw new Error("Search query is required");
  }

  const model = options.model?.trim() || DEFAULT_SEARCH_MODEL;
  const normalizedModel = normalizeModelName(model);
  const maxResults = Math.min(Math.max(options.maxResults ?? DEFAULT_MAX_RESULTS, 1), MAX_RESULTS);
  const prompt = buildSearchPrompt({ ...options, query, model });
  const routeStart = Date.now();

  let reservation: CreditReservation | null = null;
  const requestSource = auth?.requestSource ?? "api";

  if (auth?.organizationId && auth?.userId) {
    const estimatedCost =
      (await estimateRequestCost(
        normalizedModel,
        [{ role: "user", content: prompt }],
        DEFAULT_MAX_OUTPUT_TOKENS,
      )) + GOOGLE_GROUNDED_PROMPT_COST;

    try {
      reservation = await creditsService.reserve({
        organizationId: auth.organizationId,
        amount: estimatedCost,
        userId: auth.userId,
        description: `Hosted Google search: ${normalizedModel}`,
      });
    } catch (error) {
      if (error instanceof InsufficientCreditsError) {
        throw new Error(
          `Insufficient credits: need $${error.required.toFixed(4)}, have $${error.available.toFixed(4)}`,
        );
      }
      throw error;
    }
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        normalizedModel,
      )}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: "You are a factual hosted search tool. Answer only with grounded web information. Do not invent unsupported facts.",
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          tools: [{ google_search: {} }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    const body = (await response.json()) as GoogleSearchResponse;
    if (!response.ok) {
      throw new Error(
        body.error?.message || `Google Search request failed with ${response.status}`,
      );
    }

    const answer = extractAnswer(body);
    if (!answer) {
      throw new Error("Google Search returned no grounded answer");
    }

    const usage = buildUsage(body);
    const results = buildSearchResults(body, maxResults);
    const searchQueries = buildSearchQueries(body);
    const tokenCost = await calculateCost(
      normalizedModel,
      "google",
      usage.inputTokens,
      usage.outputTokens,
    );
    const totalCost = tokenCost.totalCost + GOOGLE_GROUNDED_PROMPT_COST;

    if (reservation) {
      await reservation.reconcile(totalCost);
    }

    if (auth?.organizationId && auth?.userId) {
      const apiKeyId = await resolveApiKeyId(auth);
      await usageService.create({
        organization_id: auth.organizationId,
        user_id: auth.userId,
        api_key_id: apiKeyId,
        type: "search",
        model: normalizedModel,
        provider: "google",
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        input_cost: String(tokenCost.inputCost + GOOGLE_GROUNDED_PROMPT_COST),
        output_cost: String(tokenCost.outputCost),
        is_successful: true,
        metadata: {
          grounded_search_fee: GOOGLE_GROUNDED_PROMPT_COST,
          request_source: requestSource,
          search_queries: searchQueries,
          results_count: results.length,
          source: options.source ?? null,
          topic: options.topic ?? null,
        },
      });
    }

    return {
      answer,
      model: normalizedModel,
      provider: "google",
      query,
      responseTime: Date.now() - routeStart,
      results,
      searchQueries,
      usage,
      cost: totalCost,
    };
  } catch (error) {
    if (reservation) {
      try {
        await reservation.reconcile(0);
      } catch (refundError) {
        logger.error("[Hosted Google Search] Failed to refund reservation", {
          error: refundError instanceof Error ? refundError.message : String(refundError),
        });
      }
    }

    logger.error("[Hosted Google Search] Request failed", {
      error: error instanceof Error ? error.message : String(error),
      query,
      requestSource,
    });
    throw error;
  }
}
