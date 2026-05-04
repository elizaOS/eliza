import { Buffer } from "node:buffer";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { seoArtifactsRepository } from "@/db/repositories/seo-artifacts";
import { seoProviderCallsRepository } from "@/db/repositories/seo-provider-calls";
import { seoRequestsRepository } from "@/db/repositories/seo-requests";
import type {
  NewSeoProviderCall,
  SeoArtifact,
  SeoProviderCall,
  SeoRequest,
} from "@/db/schemas/seo";
import { seoRequests, seoRequestTypeEnum } from "@/db/schemas/seo";
import { mergeAnthropicCotProviderOptions } from "@/lib/providers/anthropic-thinking";
import { getLanguageModel } from "@/lib/providers/language-model";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { logger } from "@/lib/utils/logger";
import { creditsService } from "./credits";

export type CreateSeoRequestParams = {
  organizationId: string;
  userId?: string;
  apiKeyId?: string;
  appId?: string;
  type: (typeof seoRequestTypeEnum.enumValues)[number];
  pageUrl?: string;
  keywords?: string[];
  locale?: string;
  searchEngine?: string;
  device?: string;
  environment?: string;
  agentIdentifier?: string;
  promptContext?: string;
  idempotencyKey?: string;
  locationCode?: number;
  query?: string;
};

export type SeoRequestResult = {
  request: SeoRequest;
  artifacts: SeoArtifact[];
  providerCalls: SeoProviderCall[];
};

const SEO_PRICING = {
  keywordResearch: 0.05,
  serpSnapshot: 0.01,
  claudeGenerationFloor: 0.01,
  indexNow: 0,
  healthCheck: 0,
} as const;

function ensureEnv(variable: string, description: string): string {
  const value = process.env[variable];
  if (!value) {
    throw new Error(`${variable} is required for ${description}`);
  }
  return value;
}

function parseJson<T>(raw: string): T {
  const parsed = JSON.parse(raw) as T;
  return parsed;
}

async function chargeCredits(
  organizationId: string,
  amount: number,
  description: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (amount <= 0) return;
  const result = await creditsService.deductCredits({
    organizationId,
    amount,
    description,
    metadata,
  });
  if (!result.success) {
    throw new Error("Insufficient credits for SEO operation");
  }
}

async function callDataForSeoKeywords(
  keywords: string[],
  locale: string,
  locationCode?: number,
): Promise<{ keyword: string; searchVolume: number; cpc: number; competition: number }[]> {
  const login = ensureEnv("DATAFORSEO_LOGIN", "DataForSEO API access");
  const password = ensureEnv("DATAFORSEO_PASSWORD", "DataForSEO API access");

  const auth = Buffer.from(`${login}:${password}`).toString("base64");
  const taskPayload = {
    language_code: locale?.split("-")[0] || "en",
    location_code: locationCode ?? 2840,
    keywords,
  };

  const response = await fetch(
    "https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: [taskPayload] }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DataForSEO request failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as {
    tasks: Array<{
      result: Array<{
        keyword_data: Array<{
          keyword: string;
          search_volume: number;
          cpc: number;
          competition: number;
        }>;
      }>;
    }>;
  };

  const task = json.tasks?.[0]?.result?.[0];
  if (!task) {
    return [];
  }

  return task.keyword_data.map((entry) => ({
    keyword: entry.keyword,
    searchVolume: entry.search_volume,
    cpc: entry.cpc,
    competition: entry.competition,
  }));
}

async function callSerpApiSnapshot(params: {
  query: string;
  locale: string;
  device: string;
  searchEngine: string;
}): Promise<
  Array<{
    position: number;
    title: string;
    url: string;
    displayedUrl?: string;
    snippet?: string;
  }>
> {
  const apiKey = ensureEnv("SERPAPI_KEY", "SerpApi access");
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("q", params.query);
  url.searchParams.set("engine", params.searchEngine || "google");
  url.searchParams.set("hl", params.locale || "en");
  url.searchParams.set("device", params.device || "desktop");
  url.searchParams.set("api_key", apiKey);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SerpApi request failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as {
    organic_results?: Array<{
      position?: number;
      title?: string;
      link?: string;
      displayed_link?: string;
      snippet?: string;
    }>;
  };

  return (
    json.organic_results?.map((result) => ({
      position: result.position ?? 0,
      title: result.title ?? "Untitled",
      url: result.link ?? "",
      displayedUrl: result.displayed_link,
      snippet: result.snippet,
    })) ?? []
  );
}

async function callClaudeSeoDraft(
  promptContext: string,
  type: "meta" | "schema",
  locale: string,
  pageUrl?: string,
  keywords?: string[],
): Promise<{
  title?: string;
  description?: string;
  keywords?: string[];
  metaTags?: Record<string, string>;
  schema?: Record<string, unknown>;
}> {
  const modelId = "anthropic/claude-sonnet-4.6";
  // Note: Explicitly disable extended thinking (pass 0) for SEO generation.
  // This is a background service that does not benefit from CoT, and enabling it
  // would silently drop temperature control per @ai-sdk/anthropic behavior.
  // WARNING: If ANTHROPIC_COT_BUDGET is set and budget 0 is not passed here,
  // temperature will be ignored by the AI SDK when thinking is enabled.
  // Temperature 0.3 for deterministic, consistent SEO metadata output.
  const { text } = await generateText({
    model: getLanguageModel(modelId),
    temperature: 0.3,
    ...mergeAnthropicCotProviderOptions(modelId, process.env, 0),
    system:
      type === "meta"
        ? "Generate concise SEO metadata JSON with keys: title, description, keywords (array), metaTags (object). Keep title <= 60 chars, description <= 155 chars."
        : "Generate JSON-LD schema object for a web page. Return JSON with key 'schema' containing an object that is safe to embed in a <script type=\"application/ld+json\"> tag.",
    prompt: [
      `Locale: ${locale}`,
      pageUrl ? `Page URL: ${pageUrl}` : "",
      keywords && keywords.length > 0 ? `Target keywords: ${keywords.join(", ")}` : "",
      `Context: ${promptContext}`,
      "Return strictly JSON. Do not include markdown.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  return parseJson<{
    title?: string;
    description?: string;
    keywords?: string[];
    metaTags?: Record<string, string>;
    schema?: Record<string, unknown>;
  }>(text);
}

async function submitIndexNow(urlToSubmit: string): Promise<{ submitted: boolean }> {
  const key = ensureEnv("INDEXNOW_KEY", "IndexNow submissions");
  const keyLocation = ensureEnv("INDEXNOW_KEY_LOCATION", "IndexNow key location");
  const url = await assertSafeOutboundUrl(urlToSubmit);

  const response = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      host: url.host,
      key,
      keyLocation,
      urlList: [urlToSubmit],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`IndexNow submission failed: ${response.status} ${text}`);
  }

  return { submitted: true };
}

async function runHealthCheck(pageUrl: string): Promise<{
  ok: boolean;
  status: number;
  robots: boolean;
  canonical?: string;
}> {
  const safeUrl = await assertSafeOutboundUrl(pageUrl);
  const response = await fetch(safeUrl, {
    method: "GET",
    redirect: "error",
  });
  const body = await response.text();
  const canonicalMatch = body.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
  const robotsNoindex = body.match(/noindex/i) !== null;

  return {
    ok: response.ok,
    status: response.status,
    robots: !robotsNoindex,
    canonical: canonicalMatch?.[1],
  };
}

export class SeoService {
  async createRequest(params: CreateSeoRequestParams): Promise<SeoRequestResult> {
    if (params.idempotencyKey) {
      const existing = await seoRequestsRepository.findByIdempotency(
        params.organizationId,
        params.idempotencyKey,
      );
      if (existing) {
        const artifacts = await seoArtifactsRepository.listByRequest(existing.id);
        const providerCalls = await seoProviderCallsRepository.listByRequest(existing.id);
        return { request: existing, artifacts, providerCalls };
      }
    }

    const request = await seoRequestsRepository.create({
      organization_id: params.organizationId,
      app_id: params.appId,
      user_id: params.userId,
      api_key_id: params.apiKeyId,
      type: params.type,
      status: "pending",
      page_url: params.pageUrl,
      locale: params.locale || "en-US",
      search_engine: params.searchEngine || "google",
      device: params.device || "desktop",
      environment: params.environment || "production",
      agent_identifier: params.agentIdentifier,
      keywords: params.keywords ?? [],
      prompt_context: params.promptContext,
      idempotency_key: params.idempotencyKey,
      total_cost: "0",
    });

    return await this.processRequest(request, params);
  }

  async processRequest(
    request: SeoRequest,
    params: CreateSeoRequestParams,
  ): Promise<SeoRequestResult> {
    const pageUrlRequiredTypes: Array<(typeof seoRequestTypeEnum.enumValues)[number]> = [
      "meta_generate",
      "schema_generate",
      "publish_bundle",
      "index_now",
      "health_check",
    ];

    if (pageUrlRequiredTypes.includes(request.type) && !request.page_url) {
      throw new Error("pageUrl is required for this SEO request type");
    }

    await seoRequestsRepository.updateStatus(request.id, "in_progress");
    const artifacts: SeoArtifact[] = [];
    const providerCalls: SeoProviderCall[] = [];
    let totalCost = 0;

    const charge = async (
      amount: number,
      description: string,
      metadata?: Record<string, unknown>,
    ) => {
      if (amount <= 0) return;
      await chargeCredits(request.organization_id, amount, description, metadata);
      totalCost += amount;
    };

    const recordCall = async (
      call: Omit<NewSeoProviderCall, "created_at">,
      fn: () => Promise<Record<string, unknown>>,
    ): Promise<Record<string, unknown>> => {
      const created = await seoProviderCallsRepository.create({
        ...call,
        status: "pending",
      });
      let payload: Record<string, unknown>;
      try {
        payload = await fn();
        await seoProviderCallsRepository.updateStatus(created.id, "completed", {
          response_payload: payload,
        });
        providerCalls.push({
          ...created,
          status: "completed",
          response_payload: payload,
        });
        return payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Provider call failed";
        await seoProviderCallsRepository.updateStatus(created.id, "failed", {
          error: message,
        });
        throw error;
      }
    };

    const runMetaGeneration = async (): Promise<Record<string, unknown>> => {
      return await recordCall(
        {
          request_id: request.id,
          provider: "claude",
          operation: "meta_generation",
          cost: String(SEO_PRICING.claudeGenerationFloor),
          request_payload: {
            page_url: request.page_url,
            keywords: request.keywords,
            locale: request.locale,
          },
        },
        async () => {
          const result = await callClaudeSeoDraft(
            params.promptContext || "Generate SEO metadata.",
            "meta",
            request.locale,
            request.page_url ?? undefined,
            request.keywords ?? undefined,
          );
          await charge(SEO_PRICING.claudeGenerationFloor, "SEO meta generation (Claude)", {
            request_id: request.id,
          });
          const artifact = await seoArtifactsRepository.create({
            request_id: request.id,
            type: "meta",
            provider: "claude",
            data: result,
          });
          artifacts.push(artifact);
          return result;
        },
      );
    };

    const runSchemaGeneration = async (): Promise<Record<string, unknown>> => {
      return await recordCall(
        {
          request_id: request.id,
          provider: "claude",
          operation: "schema_generation",
          cost: String(SEO_PRICING.claudeGenerationFloor),
          request_payload: {
            page_url: request.page_url,
            keywords: request.keywords,
            locale: request.locale,
          },
        },
        async () => {
          const result = await callClaudeSeoDraft(
            params.promptContext || "Generate structured data.",
            "schema",
            request.locale,
            request.page_url ?? undefined,
            request.keywords ?? undefined,
          );
          await charge(SEO_PRICING.claudeGenerationFloor, "SEO schema generation (Claude)", {
            request_id: request.id,
          });
          const artifact = await seoArtifactsRepository.create({
            request_id: request.id,
            type: "schema",
            provider: "claude",
            data: { schema: result.schema },
          });
          artifacts.push(artifact);
          return result;
        },
      );
    };

    try {
      switch (request.type) {
        case "keyword_research": {
          await recordCall(
            {
              request_id: request.id,
              provider: "dataforseo",
              operation: "keywords_for_keywords",
              cost: String(SEO_PRICING.keywordResearch),
              request_payload: {
                keywords: params.keywords ?? [],
                locale: request.locale,
                location_code: params.locationCode ?? 2840,
              },
            },
            async () => {
              const result = await callDataForSeoKeywords(
                params.keywords ?? [],
                request.locale,
                params.locationCode,
              );
              await charge(SEO_PRICING.keywordResearch, "SEO keyword research (DataForSEO)", {
                request_id: request.id,
              });
              const artifact = await seoArtifactsRepository.create({
                request_id: request.id,
                type: "keywords",
                provider: "dataforseo",
                data: { keywords: result },
              });
              artifacts.push(artifact);
              return { keywords: result };
            },
          );
          break;
        }
        case "serp_snapshot": {
          const query = params.query || params.keywords?.[0];
          if (!query) {
            throw new Error("Query or keywords required for SERP snapshot");
          }
          await recordCall(
            {
              request_id: request.id,
              provider: "serpapi",
              operation: "serp_snapshot",
              cost: String(SEO_PRICING.serpSnapshot),
              request_payload: {
                query,
                locale: request.locale,
                search_engine: request.search_engine,
                device: request.device,
              },
            },
            async () => {
              const results = await callSerpApiSnapshot({
                query,
                locale: request.locale,
                device: request.device,
                searchEngine: request.search_engine,
              });
              await charge(SEO_PRICING.serpSnapshot, "SEO SERP snapshot (SerpApi)", {
                request_id: request.id,
              });
              const artifact = await seoArtifactsRepository.create({
                request_id: request.id,
                type: "serp_snapshot",
                provider: "serpapi",
                data: { results },
              });
              artifacts.push(artifact);
              return { results };
            },
          );
          break;
        }
        case "meta_generate": {
          await runMetaGeneration();
          break;
        }
        case "schema_generate": {
          await runSchemaGeneration();
          break;
        }
        case "publish_bundle": {
          await runMetaGeneration();
          await runSchemaGeneration();

          if (request.page_url) {
            await recordCall(
              {
                request_id: request.id,
                provider: "indexnow",
                operation: "indexnow_submit",
                cost: String(SEO_PRICING.indexNow),
                request_payload: { url: request.page_url },
              },
              async () => {
                const result = await submitIndexNow(request.page_url!);
                const artifact = await seoArtifactsRepository.create({
                  request_id: request.id,
                  type: "indexnow_submission",
                  provider: "indexnow",
                  data: result,
                });
                artifacts.push(artifact);
                return result;
              },
            );
          }
          break;
        }
        case "index_now": {
          if (!request.page_url) {
            throw new Error("pageUrl is required for IndexNow submission");
          }
          await recordCall(
            {
              request_id: request.id,
              provider: "indexnow",
              operation: "indexnow_submit",
              cost: String(SEO_PRICING.indexNow),
              request_payload: { url: request.page_url },
            },
            async () => {
              const result = await submitIndexNow(request.page_url!);
              const artifact = await seoArtifactsRepository.create({
                request_id: request.id,
                type: "indexnow_submission",
                provider: "indexnow",
                data: result,
              });
              artifacts.push(artifact);
              return result;
            },
          );
          break;
        }
        case "health_check": {
          if (!request.page_url) {
            throw new Error("pageUrl is required for health check");
          }
          await recordCall(
            {
              request_id: request.id,
              provider: "bing",
              operation: "health_check",
              cost: String(SEO_PRICING.healthCheck),
              request_payload: { url: request.page_url },
            },
            async () => {
              const result = await runHealthCheck(request.page_url!);
              const artifact = await seoArtifactsRepository.create({
                request_id: request.id,
                type: "health_report",
                provider: "bing",
                data: result,
              });
              artifacts.push(artifact);
              return result;
            },
          );
          break;
        }
        default:
          throw new Error(`Unsupported SEO request type: ${request.type}`);
      }

      if (process.env.SEO_SKIP_DB_PERSIST === "true") {
        return {
          request: {
            ...request,
            status: "completed",
            total_cost: String(totalCost),
            updated_at: new Date(),
            completed_at: new Date(),
          },
          artifacts,
          providerCalls,
        };
      }

      await db
        .update(seoRequests)
        .set({
          status: "completed",
          total_cost: String(totalCost),
          updated_at: new Date(),
          completed_at: new Date(),
        })
        .where(eq(seoRequests.id, request.id));

      const fresh = await seoRequestsRepository.findById(request.id);
      return {
        request: fresh || request,
        artifacts,
        providerCalls,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "SEO request failed";
      await seoRequestsRepository.updateStatus(request.id, "failed", {
        error: message,
      });
      logger.error("[SeoService] request failed", {
        requestId: request.id,
        error: message,
      });
      throw error;
    }
  }
}

export const seoService = new SeoService();
