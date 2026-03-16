import { IAgentRuntime, logger, Service } from "@elizaos/core";
import { tavily } from "@tavily/core";
import type { ITavilyService, SearchOptions, SearchResponse } from "../types";

export type TavilyClient = ReturnType<typeof tavily>;

export class TavilyService extends Service implements ITavilyService {
  static serviceType = "TAVILY" as const;

  private tavilyClient!: TavilyClient;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<TavilyService> {
    const service = new TavilyService(runtime);
    await service.initialize(runtime);
    return service;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    const apiKey = runtime.getSetting("TAVILY_API_KEY") as string;
    if (!apiKey) {
      throw new Error("TAVILY_API_KEY is not set");
    }
    this.tavilyClient = tavily({ apiKey });
  }

  get capabilityDescription(): string {
    return "Web search via Tavily API. Supports answer synthesis and result listing with optional images.";
  }

  async stop(): Promise<void> {
    // No persistent connections to close for Tavily client
  }

  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    try {
      if (!this.tavilyClient) {
        throw new Error("TavilyService not initialized");
      }

      const response = await this.tavilyClient.search(query, {
        auto_parameters: options?.auto_parameters,
        topic: options?.topic ?? "general",
        search_depth: options?.search_depth ?? "basic",
        chunks_per_source: options?.chunks_per_source,
        max_results: options?.max_results ?? 5,
        time_range: options?.time_range,
        start_date: options?.start_date,
        end_date: options?.end_date,
        include_answer: options?.include_answer ?? false,
        include_raw_content: options?.include_raw_content,
        include_images: options?.include_images ?? false,
        include_image_descriptions: options?.include_image_descriptions,
        include_favicon: options?.include_favicon,
        include_domains: options?.include_domains,
        exclude_domains: options?.exclude_domains,
        country: options?.country,
      });

      return response;
    } catch (error) {
      logger.error(
        { src: "tavilyService:search", error: (error as Error).message },
        "Tavily search error",
      );
      throw error;
    }
  }
}
