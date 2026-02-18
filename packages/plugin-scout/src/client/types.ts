// ─── Trust Levels ───────────────────────────────────────────────────────────

export type TrustLevel = "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";

export type Verdict =
  | "RECOMMENDED"
  | "USABLE"
  | "CAUTION"
  | "NOT_RECOMMENDED";

export type HealthStatus = "UP" | "DOWN" | "TIMEOUT" | "UNKNOWN";

export type SkillBadge = "safe" | "caution" | "warning" | "danger";

// ─── Service Score (/api/bazaar/score/:domain) ──────────────────────────────

export interface ServiceScoreResponse {
  success: boolean;
  domain: string;
  resourceUrl: string;
  score: number;
  level: TrustLevel;
  dimensions: {
    contractClarity: number;
    availability: number;
    responseFidelity: number;
    identitySafety: number;
  };
  flags: string[];
  recommendation: {
    verdict: Verdict;
    message: string;
    maxTransaction: number;
    escrowAdvised: boolean | "optional";
    escrowReason: string;
    paymentMethod: string;
    riskFactors: string[];
    suggestedTerms: {
      upfront: string;
      onCompletion: string;
      escrow: string;
      releaseConditions: string;
    };
    suggestedEscrowProvider?: {
      name: string;
      url: string;
      note: string;
    };
  };
  serviceInfo: {
    description: string;
    priceUSD: number;
    network: string;
    wallet: string | null;
    hasSchema: boolean;
    lastUpdated: string;
  };
  endpointHealth?: {
    status: HealthStatus;
    statusCode: number;
    latencyMs: number;
    lastChecked: string;
  };
  reliability?: {
    uptime7d: number | null;
    uptime30d: number | null;
    avgLatency7d: number | null;
    trend: string | null;
    sufficientData: boolean;
  };
  fidelity?: {
    score: number;
    protocolScore: number;
    consistencyScore: number;
    structureScore: number;
    checksTotal: number;
    lastChecked: string;
  };
  _meta: {
    tier: string;
    dataSource: string;
    scoredAt: string;
  };
}

// ─── Batch Score (/api/bazaar/batch) ────────────────────────────────────────

export interface BatchScoreRequest {
  domains: string[];
}

export interface BatchScoreResult {
  success?: boolean;
  domain: string;
  resourceUrl?: string;
  score: number | null;
  level: TrustLevel | null;
  flags?: string[];
  error?: string;
}

export interface BatchScoreResponse {
  success: boolean;
  batch: {
    total: number;
    scored: number;
    notFound: number;
    averageScore: number;
    distribution: Record<TrustLevel, number>;
  };
  results: BatchScoreResult[];
  _meta: {
    tier: string;
    dataSource: string;
    scoredAt: string;
  };
}

// ─── Fidelity (/api/bazaar/fidelity/:domain) ────────────────────────────────

export interface FidelityResponse {
  success: boolean;
  domain: string;
  endpointUrl?: string;
  fidelityScore: number;
  level: TrustLevel;
  layers: {
    protocolCompliance: { score: number };
    contractConsistency: { score: number };
    responseStructure: { score: number };
  };
  flags: string[];
  checkDurationMs: number | null;
  checksTotal: number;
  lastChecked: string;
  _meta: {
    cached: boolean;
    tier: string;
    dataSource: string;
    checkedAt: string;
  };
}

// ─── Stats (/api/bazaar/stats) ──────────────────────────────────────────────

export interface StatsResponse {
  success: boolean;
  stats: {
    services: {
      total: number;
      networks: number;
      note: string;
    };
    pricing: {
      free: number;
      paid: number;
      averagePriceUSD: number;
      percentPaid: number;
    };
    schemas: {
      withSchema: number;
      coveragePercent: number;
    };
  };
  meta: {
    dataSource: string;
    lastUpdated: string;
    version: string;
  };
}

// ─── Leaderboard (/api/leaderboard) ─────────────────────────────────────────

export interface LeaderboardOptions {
  search?: string;
  category?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

export interface LeaderboardEntry {
  rank: number;
  domain: string;
  description: string | null;
  score: number;
  level: TrustLevel;
  hasSchema: boolean;
  priceUSD: number;
  network: string;
  serviceCount: number;
  category: string;
  verified: boolean;
  source: string;
  liveness: HealthStatus;
  latencyMs: number | null;
  lastChecked: string | null;
  fidelity: {
    score: number;
    level: TrustLevel;
    protocolScore: number;
    consistencyScore: number;
    structureScore: number;
    lastChecked: string;
  } | null;
  flags: string[];
  platform: string;
}

export interface LeaderboardResponse {
  success: boolean;
  stats: {
    totalServices: number;
    legitimateServices: number;
    uniqueWallets: number;
    avgServiceScore: number;
    serviceDistribution: Record<TrustLevel, number>;
    platforms: string[];
    categoryCounts: Record<string, number>;
    sourceCounts: Record<string, number>;
  };
  services: LeaderboardEntry[];
  _meta: {
    limit: number;
    offset: number;
    tier: string;
    dataSource: string[];
    timestamp: string;
  };
}

// ─── Skill Scan Sub-types ────────────────────────────────────────────────────

export interface SkillPublisherScore {
  score: number;
  name: string;
  verified: boolean;
  verification_method: string | null;
  skills_published: number;
  flags: number;
  notes: string;
}

export interface SkillEndpointEntry {
  url: string;
  domain: string;
  status: "trusted" | "unknown" | "spam";
  bazaar_score: number | null;
}

export interface SkillEndpointScore {
  score: number;
  x402_endpoints: SkillEndpointEntry[];
  notes?: string;
}

export interface SkillDomainScore {
  score: number;
  external_calls: Array<{ domain: string; known: boolean; category?: string }>;
  unknown_domains: string[];
  notes?: string;
}

export interface SkillRecommendations {
  install: boolean;
  escrow: "required" | "recommended" | "optional";
  notes: string;
  warnings: string[];
}

// ─── Skill Scan (/api/skill/scan) ───────────────────────────────────────────

export interface SkillScanRequest {
  source: string;
  identifier: string;
  version?: string;
  publisher?: string;
  files: Record<string, string>;
}

export interface SkillScanResponse {
  skill: string;
  source: string;
  version: string | null;
  score: number;
  badge: SkillBadge;
  scanned_at: string;
  publisher: SkillPublisherScore;
  endpoints: SkillEndpointScore;
  domains: SkillDomainScore;
  recommendations: SkillRecommendations;
  _cached?: boolean;
  _cache_expires?: string;
  _meta?: {
    tier: string;
    endpoint: string;
  };
}

// ─── Skill Score (/api/skill/score/:source/:identifier) ─────────────────────

export interface SkillScoreOptions {
  fetch?: boolean;
  version?: string;
  publisher?: string;
  path?: string;
}

export interface SkillScoreResponse {
  skill: string;
  source: string;
  version: string | null;
  score: number;
  badge: SkillBadge;
  scanned_at: string;
  fetched_from?: string;
  files_scanned?: number;
  publisher: SkillPublisherScore;
  endpoints: SkillEndpointScore;
  domains: SkillDomainScore;
  recommendations: SkillRecommendations;
  _cached: boolean;
  _cache_expires?: string;
  _fetch_metadata?: {
    files_available: number;
    files_truncated: boolean;
    errors: string[];
  };
  _meta?: {
    rate_limit_weight: number;
    endpoint: string;
  };
}

// ─── Webhook (/api/webhook/register) ────────────────────────────────────────

export interface WebhookRegisterRequest {
  publisher_name: string;
  callback_url: string;
  events: string[];
  secret?: string;
}

export interface WebhookRegisterResponse {
  webhook_id: string;
  status: "pending_verification" | "active";
  callback_url: string;
  events: string[];
  secret: string;
  verification_token: string;
  created_at: string;
  message: string;
  next_steps: string[];
  docs: string;
}

// ─── Health (/api/health) ───────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  version: string;
  endpoints: Record<
    string,
    { tier: string; price: string }
  >;
  payment: {
    currency: string;
    network: string;
    recipient: string;
    currentPricing: string;
  };
}

// ─── Error Response ─────────────────────────────────────────────────────────

export interface ScoutErrorResponse {
  error: string;
  details?: string;
}

// ─── Client Configuration ───────────────────────────────────────────────────

export interface ScoutClientConfig {
  baseUrl: string;
  apiKey?: string;
  agentId?: string;
  agentName?: string;
  pluginVersion?: string;
}