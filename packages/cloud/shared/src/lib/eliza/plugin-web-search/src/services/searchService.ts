// Wires hosted Eliza agent searchService behavior for cloud runtime services.
import { type IAgentRuntime, logger, Service } from "@elizaos/core/edge";
import type { HostedSearchResult } from "../../../../services/google-search";
import type { IWebSearchService, SearchOptions, SearchResponse } from "../types";
import { executeKeylessMcpSearch } from "./keyless-search";

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
    // No key required: without a Google/Gemini key the service serves the
    // keyless MCP path (Parallel → Exa) instead of refusing to start, so a
    // hosted agent always has working web search.
    if (!getGoogleSearchApiKey(runtime)) {
      logger.info(
        { src: "webSearchService:initialize" },
        "No Google search key configured; using keyless MCP search (Parallel → Exa)",
      );
    }
  }

  get capabilityDescription(): string {
    return "Web search: Google-grounded via Gemini when a key is configured, otherwise keyless MCP search (Parallel with Exa fallback).";
  }

  async stop(): Promise<void> {}

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    if (!getGoogleSearchApiKey(this.runtime)) {
      const started = Date.now();
      const keyless = await executeKeylessMcpSearch(query, options?.max_results ?? 5);
      return {
        answer: keyless.answer,
        query,
        responseTime: (Date.now() - started) / 1000,
        images: [],
        results: [],
        provider: keyless.provider,
      };
    }
    try {
      // Lazy import: the Google-grounded path drags the cloud services/db
      // graph; keyless deployments never pay that module cost.
      const { executeHostedGoogleSearch } = await import("../../../../services/google-search");
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
