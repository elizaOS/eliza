import { ScoutCache } from "./cache.js";
import type {
  ScoutClientConfig,
  ServiceScoreResponse,
  BatchScoreRequest,
  BatchScoreResponse,
  FidelityResponse,
  StatsResponse,
  LeaderboardOptions,
  LeaderboardResponse,
  SkillScanRequest,
  SkillScanResponse,
  SkillScoreOptions,
  SkillScoreResponse,
  WebhookRegisterRequest,
  WebhookRegisterResponse,
  HealthResponse,
  ScoutErrorResponse,
} from "./types.js";

const PLUGIN_VERSION = "0.1.0";

export class ScoutClient {
  private readonly baseUrl: string;
  private readonly cache: ScoutCache;
  private readonly apiKey?: string;
  private readonly agentId?: string;
  private readonly agentName?: string;

  constructor(config: ScoutClientConfig, cache: ScoutCache) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.cache = cache;
    this.apiKey = config.apiKey;
    this.agentId = config.agentId;
    this.agentName = config.agentName;
  }

  // ── Service Trust Scoring ───────────────────────────────────────────────

  async getServiceScore(domain: string): Promise<ServiceScoreResponse> {
    const cacheKey = `service:${domain}`;
    const cached = this.cache.get<ServiceScoreResponse>(cacheKey);
    if (cached) return cached;

    const data = await this.get<ServiceScoreResponse>(
      `/api/bazaar/score/${encodeURIComponent(domain)}`,
      "CHECK_SERVICE_TRUST"
    );
    this.cache.set(cacheKey, data);
    return data;
  }

  async batchScore(domains: string[]): Promise<BatchScoreResponse> {
    const body: BatchScoreRequest = { domains };
    return this.post<BatchScoreResponse>(
      "/api/bazaar/batch",
      body,
      "BATCH_SCORE_SERVICES"
    );
  }

  // ── Fidelity Probing ──────────────────────────────────────────────────

  async getServiceFidelity(
    domain: string,
    fresh = false
  ): Promise<FidelityResponse> {
    const cacheKey = `fidelity:${domain}:${fresh}`;
    const cached = this.cache.get<FidelityResponse>(cacheKey);
    if (cached) return cached;

    const query = fresh ? "?fresh=true" : "";
    const data = await this.get<FidelityResponse>(
      `/api/bazaar/fidelity/${encodeURIComponent(domain)}${query}`,
      "CHECK_FIDELITY"
    );
    this.cache.set(cacheKey, data);
    return data;
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  async getStats(): Promise<StatsResponse> {
    const cacheKey = "stats";
    const cached = this.cache.get<StatsResponse>(cacheKey);
    if (cached) return cached;

    const data = await this.get<StatsResponse>(
      "/api/bazaar/stats",
      "GET_STATS"
    );
    this.cache.set(cacheKey, data);
    return data;
  }

  // ── Leaderboard ───────────────────────────────────────────────────────

  async getLeaderboard(
    options: LeaderboardOptions = {}
  ): Promise<LeaderboardResponse> {
    const params = new URLSearchParams();
    if (options.search) params.set("search", options.search);
    if (options.category) params.set("category", options.category);
    if (options.source) params.set("source", options.source);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));

    const query = params.toString() ? `?${params.toString()}` : "";
    const cacheKey = `leaderboard:${query}`;
    const cached = this.cache.get<LeaderboardResponse>(cacheKey);
    if (cached) return cached;

    const data = await this.get<LeaderboardResponse>(
      `/api/leaderboard${query}`,
      "BROWSE_LEADERBOARD"
    );
    this.cache.set(cacheKey, data);
    return data;
  }

  // ── Skill Scanning ────────────────────────────────────────────────────

  async scanSkill(request: SkillScanRequest): Promise<SkillScanResponse> {
    return this.post<SkillScanResponse>(
      "/api/skill/scan",
      request,
      "SCAN_SKILL"
    );
  }

  async getSkillScore(
    source: string,
    identifier: string,
    options: SkillScoreOptions = {}
  ): Promise<SkillScoreResponse> {
    const params = new URLSearchParams();
    if (options.fetch) params.set("fetch", "true");
    if (options.version) params.set("version", options.version);
    if (options.publisher) params.set("publisher", options.publisher);
    if (options.path) params.set("path", options.path);

    const query = params.toString() ? `?${params.toString()}` : "";
    const cacheKey = `skill:${source}:${identifier}:${query}`;
    const cached = this.cache.get<SkillScoreResponse>(cacheKey);
    if (cached) return cached;

    const data = await this.get<SkillScoreResponse>(
      `/api/skill/score/${encodeURIComponent(source)}/${encodeURIComponent(identifier)}${query}`,
      "GET_SKILL_SCORE"
    );
    this.cache.set(cacheKey, data);
    return data;
  }

  // ── Webhooks (Authenticated) ──────────────────────────────────────────

  async registerWebhook(
    request: WebhookRegisterRequest
  ): Promise<WebhookRegisterResponse> {
    return this.post<WebhookRegisterResponse>(
      "/api/webhook/register",
      request,
      "REGISTER_WEBHOOK"
    );
  }

  // ── Health ────────────────────────────────────────────────────────────

  async getHealth(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/api/health", "HEALTH_CHECK");
  }

  // ── HTTP Primitives ───────────────────────────────────────────────────

  private buildHeaders(action: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Scout-Plugin-Version": PLUGIN_VERSION,
      "X-Scout-Action": action,
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (this.agentId) {
      headers["X-Scout-Agent-Id"] = this.agentId;
    }
    if (this.agentName) {
      headers["X-Scout-Agent-Name"] = this.agentName;
    }

    return headers;
  }

  private async get<T>(path: string, action: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.buildHeaders(action),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as ScoutErrorResponse;
      throw new ScoutApiError(
        error.error || `HTTP ${response.status}`,
        response.status,
        error.details
      );
    }

    return (await response.json()) as T;
  }

  private async post<T>(
    path: string,
    body: unknown,
    action: string
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.buildHeaders(action),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as ScoutErrorResponse;
      throw new ScoutApiError(
        error.error || `HTTP ${response.status}`,
        response.status,
        error.details
      );
    }

    return (await response.json()) as T;
  }
}

export class ScoutApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly details?: string
  ) {
    super(message);
    this.name = "ScoutApiError";
  }
}