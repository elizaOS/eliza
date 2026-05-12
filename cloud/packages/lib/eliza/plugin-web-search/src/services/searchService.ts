import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { executeHostedGoogleSearch, type HostedSearchResult } from "@/lib/services/google-search";
import type { IWebSearchService, SearchOptions, SearchResponse } from "../types";

function getGoogleSearchApiKey(runtime: IAgentRuntime): string | null {
  const candidates = [
    runtime.getSetting("GOOGLE_API_KEY"),
    runtime.getSetting("GEMINI_API_KEY"),
    runtime.getSetting("GOOGLE_GENERATIVE_AI_API_KEY"),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function toSearchResponse(result: HostedSearchResult): SearchResponse {
  return {
    answer: result.answer,
    query: result.query,
    responseTime: result.responseTime,
    images: [],
    results: result.results.map((item) => ({
      title: item.title,
      url: item.url,
      content: item.content,
      score: item.score,
    })),
    model: result.model,
    provider: result.provider,
    searchQueries: result.searchQueries,
    usage: result.usage,
    cost: result.cost,
  };
}

export class WebSearchService extends Service implements IWebSearchService {
  static serviceType = "WEB_SEARCH" as const;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<WebSearchService> {
    const service = new WebSearchService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    const apiKey = getGoogleSearchApiKey(runtime);
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY is not set");
    }
  }

  get capabilityDescription(): string {
    return "Hosted Google-grounded web search via Gemini. Returns grounded answers, citations, and search metadata.";
  }

  async stop(): Promise<void> {}

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    try {
      const result = await executeHostedGoogleSearch(
        {
          query,
          maxResults: options?.max_results,
          model: options?.model,
          googleApiKey: getGoogleSearchApiKey(this.runtime) ?? undefined,
          source: options?.source,
          topic: options?.topic,
          timeRange: options?.time_range,
          startDate: options?.start_date,
          endDate: options?.end_date,
        },
        {
          organizationId:
            (this.runtime.getSetting("ORGANIZATION_ID") as string | undefined) ?? undefined,
          userId: (this.runtime.getSetting("USER_ID") as string | undefined) ?? undefined,
          apiKey: (this.runtime.getSetting("ELIZAOS_API_KEY") as string | undefined) ?? null,
          requestSource: "action",
        },
      );

      return toSearchResponse(result);
    } catch (error) {
      logger.error(
        {
          src: "webSearchService:search",
          error: error instanceof Error ? error.message : String(error),
        },
        "Hosted Google search error",
      );
      throw error;
    }
  }
}
