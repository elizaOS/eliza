/**
 * Cache key generators for consistent key naming across the application.
 */
export const CacheKeys = {
  org: {
    data: (orgId: string) => `org:${orgId}:data:v1`,
    credits: (orgId: string) => `org:${orgId}:credits:v1`,
    dashboard: (orgId: string) => `org:${orgId}:dashboard:v1`,
    pattern: (orgId: string) => `org:${orgId}:*`,
  },
  analytics: {
    overview: (orgId: string, timeRange: "daily" | "weekly" | "monthly") =>
      `analytics:overview:${orgId}:${timeRange}:v1`,
    breakdown: (orgId: string, dimension: string, range: string) =>
      `analytics:breakdown:${orgId}:${dimension}:${range}:v1`,
    stats: (orgId: string, dateRange: string) => `analytics:stats:${orgId}:${dateRange}:v1`,
    userBreakdown: (orgId: string, params: string) =>
      `analytics:userbreakdown:${orgId}:${params}:v1`,
    projections: (orgId: string, daysAhead: number) =>
      `analytics:projections:${orgId}:${daysAhead}:v1`,
    timeSeries: (orgId: string, granularity: string, start: string, end: string) =>
      `analytics:timeseries:${orgId}:${granularity}:${start}:${end}:v1`,
    providerBreakdown: (orgId: string, start: string, end: string) =>
      `analytics:provider:${orgId}:${start}:${end}:v1`,
    modelBreakdown: (orgId: string, start: string, end: string) =>
      `analytics:model:${orgId}:${start}:${end}:v1`,
    pattern: (orgId: string) => `analytics:*:${orgId}:*`,
  },
  apiKey: {
    validation: (keyHash: string) => `apikey:validation:${keyHash}:v1`,
    /** Cache app lookup by API key ID */
    appMapping: (apiKeyId: string) => `apikey:app:${apiKeyId}:v1`,
    pattern: () => `apikey:*`,
  },
  /**
   * App cache keys
   * Used for caching app lookups to reduce DB load on high-traffic app auth
   */
  app: {
    /** Cache app by ID */
    byId: (appId: string) => `app:${appId}:v1`,
    /** Cache app by slug */
    bySlug: (slug: string) => `app:slug:${slug}:v1`,
    /** Cache app by API key ID (for fast auth lookups) */
    byApiKeyId: (apiKeyId: string) => `app:apikey:${apiKeyId}:v1`,
    /** Cache cost markup config (monetization fields only) for hot LLM path */
    costMarkup: (appId: string) => `app:cost-markup:${appId}:v1`,
    /** Pattern for invalidating all app cache */
    pattern: () => `app:*`,
  },
  session: {
    /** Cache Steward JWT verification results */
    steward: (tokenHash: string) => `session:steward:${tokenHash}:v1`,
    /** Cache user data by session token */
    user: (tokenHash: string) => `session:user:${tokenHash}:v1`,
    pattern: () => `session:*`,
  },
  user: {
    byId: (id: string) => `user:id:${id}:v1`,
    byEmail: (email: string) => `user:email:${email}:v1`,
    byStewardId: (stewardId: string) => `user:steward:${stewardId}:v1`,
    withOrg: (id: string) => `user:with-org:${id}:v1`,
    byEmailWithOrg: (email: string) => `user:email-with-org:${email}:v1`,
    byStewardIdWithOrg: (stewardId: string) => `user:steward-with-org:${stewardId}:v1`,
    byWalletAddress: (address: string) => `user:wallet:${address}:v1`,
    byWalletAddressWithOrg: (address: string) => `user:wallet-with-org:${address}:v1`,
    pattern: () => `user:*`,
  },
  identity: {
    resolve: (platform: string, platformId: string) => `identity:${platform}:${platformId}`,
  },
  memory: {
    item: (orgId: string, memoryId: string) => `memory:${orgId}:${memoryId}:v1`,
    roomRecent: (orgId: string, roomId: string) => `memory:${orgId}:room:${roomId}:recent:v1`,
    roomContext: (orgId: string, roomId: string, depth: number) =>
      `memory:${orgId}:room:${roomId}:context:${depth}:v1`,
    search: (orgId: string, queryHash: string) => `memory:${orgId}:search:${queryHash}:v1`,
    conversationContext: (orgId: string, convId: string, depth: number) =>
      `memory:${orgId}:conv:${convId}:${depth}:v1`,
    conversationSummary: (orgId: string, convId: string) =>
      `memory:${orgId}:conv:${convId}:summary:v1`,
    patterns: (orgId: string, analysisType: string) =>
      `memory:${orgId}:patterns:${analysisType}:v1`,
    topics: (orgId: string, timeRange: string) => `memory:${orgId}:topics:${timeRange}:v1`,
    orgPattern: (orgId: string) => `memory:${orgId}:*`,
    roomPattern: (orgId: string, roomId: string) => `memory:${orgId}:room:${roomId}:*`,
  },
  agent: {
    roomContext: (roomId: string) => `agent:room:${roomId}:context:v1`,
    characterData: (agentId: string) => `agent:${agentId}:character:v1`,
    userSession: (entityId: string) => `agent:user:${entityId}:session:v1`,
    agentList: (orgId: string, filterHash: string) => `agent:list:${orgId}:${filterHash}:v1`,
    agentStats: (agentId: string) => `agent:stats:${agentId}:v1`,
  },
  container: {
    list: (orgId: string) => `containers:list:${orgId}:v1`,
    logs: (containerId: string) => `container:logs:${containerId}:recent:v1`,
    metrics: (containerId: string, period: string) =>
      `container:metrics:${containerId}:${period}:v1`,
  },
  eliza: {
    roomCharacter: (roomId: string) => `eliza:room:${roomId}:character:v1`,
    orgBalance: (orgId: string) => `eliza:org:${orgId}:balance:v1`,
    pattern: () => `eliza:*`,
  },
  /**
   * Discovery cache keys
   * Used for caching discovery results
   */
  discovery: {
    /** Cache discovery results by filter hash */
    list: (filterHash: string) => `discovery:list:${filterHash}:v2`,
    /** Pattern for invalidating all discovery cache */
    pattern: () => `discovery:*`,
  },
  models: {
    /** Cache upstream OpenRouter model catalog for selector/detail/status routes */
    openrouterCatalog: () => `models:openrouter-catalog:v1`,
    pattern: () => `models:*`,
  },
  /**
   * Code Agent cache keys
   * Used for caching session data and analytics
   */
  codeAgent: {
    session: (sessionId: string) => `code_agent:session:${sessionId}:v1`,
    list: (orgId: string) => `code_agent:list:${orgId}:v1`,
    analytics: (orgId: string, range: string) => `code_agent:analytics:${orgId}:${range}:v1`,
    pattern: (orgId: string) => `code_agent:*:${orgId}:*`,
  },
  /**
   * Admin cache keys
   * Used for caching admin status lookups to reduce DB load
   */
  admin: {
    /** Cache admin status by wallet address (isAdmin + role) */
    status: (walletAddress: string) => `admin:status:${walletAddress.toLowerCase()}:v1`,
    pattern: () => `admin:*`,
  },
  /**
   * Gallery cache keys
   * Used for caching gallery media items and stats
   */
  gallery: {
    /** Cache gallery items by org/user and filter options */
    items: (orgId: string, userId: string, filterHash: string) =>
      `gallery:items:${orgId}:${userId}:${filterHash}:v1`,
    /** Cache gallery stats by org/user */
    stats: (orgId: string, userId: string) => `gallery:stats:${orgId}:${userId}:v1`,
    /** Cache collections by org/user */
    collections: (orgId: string, userId: string) => `gallery:collections:${orgId}:${userId}:v1`,
    /** Pattern for invalidating all gallery cache for an org */
    orgPattern: (orgId: string) => `gallery:*:${orgId}:*`,
    /** Pattern for invalidating all gallery cache for a user */
    userPattern: (orgId: string, userId: string) => `gallery:*:${orgId}:${userId}:*`,
  },
  /**
   * MCP cache keys
   */
  mcp: {
    byId: (id: string) => `mcp:id:${id}:v1`,
    bySlug: (orgId: string, slug: string) => `mcp:slug:${orgId}:${slug}:v1`,
    pattern: () => `mcp:*`,
  },
  /**
   * Affiliate cache keys
   */
  affiliate: {
    codeByUserId: (userId: string) => `affiliate:code-user:${userId}:v1`,
    codeByCode: (code: string) => `affiliate:code-code:${code}:v1`,
    codeById: (id: string) => `affiliate:code-id:${id}:v1`,
    linkByUserId: (userId: string) => `affiliate:link-user:${userId}:v1`,
    pattern: () => `affiliate:*`,
  },
  /**
   * SIWE (Sign-In With Ethereum) nonce cache.
   * Single-use nonces stored by value; consumed on verify.
   */
  siwe: {
    nonce: (nonce: string) => `siwe:nonce:${nonce}:v1`,
    pattern: () => `siwe:*`,
  },
  walletAuth: {
    user: (address: string) => `wallet-auth:user:${address}:v1`,
  },
  userMetrics: {
    overview: (rangeDays?: number) => `user-metrics:overview:${rangeDays ?? 30}d:v1`,
    daily: (start: string, end: string) => `user-metrics:daily:${start}:${end}:v1`,
    retention: (start: string, end: string) => `user-metrics:retention:${start}:${end}:v1`,
    activeUsers: (range: string) => `user-metrics:active:${range}:v1`,
    signups: (start: string, end: string) => `user-metrics:signups:${start}:${end}:v1`,
    pattern: () => `user-metrics:*`,
  },
} as const;

/**
 * Time-to-live values (in seconds) for different cache categories.
 */
export const CacheTTL = {
  org: {
    data: 300, // 5 minutes (was 60s)
    credits: 60, // 1 minute (was 15s)
    dashboard: 300, // 5 minutes (was 90s) - stale after 180s
  },
  analytics: {
    overview: {
      daily: 300, // 5 minutes (was 120s)
      weekly: 600, // 10 minutes (was 180s)
      monthly: 1800, // 30 minutes (was 300s)
    },
    breakdown: 600, // 10 minutes (was 180s)
    stats: 600, // 10 minutes (was 300s)
    userBreakdown: 1800, // 30 minutes (was 600s)
    projections: 600, // 10 minutes (was 300s)
    timeSeries: 600, // 10 minutes (was 180s)
    providerBreakdown: 600, // 10 minutes (was 180s)
    modelBreakdown: 600, // 10 minutes (was 180s)
  },
  apiKey: {
    validation: 600, // 10 minutes (was 300s)
    appMapping: 600, // 10 minutes - app-to-API-key mapping rarely changes
  },
  /**
   * App cache TTLs
   * Moderate TTLs since apps change infrequently
   */
  app: {
    byId: 300, // 5 minutes - app details (matches org:data pattern)
    bySlug: 300, // 5 minutes - app by slug
    byApiKeyId: 600, // 10 minutes - app lookup by API key
    /** Negative cache for missing apps (not found) */
    none: 60, // 1 minute - prevents repeated DB lookups for invalid IDs/slugs
    /** Markup config used on every inference request — short enough to react to monetization toggles */
    costMarkup: 300, // 5 minutes
  },
  session: {
    steward: 300, // 5 minutes - Steward JWT validation
    user: 300, // 5 minutes - User data by session
  },
  user: {
    byId: 600, // 10 minutes
    byEmail: 600, // 10 minutes (was 300s)
    byStewardId: 600,
    withOrg: 600,
    byEmailWithOrg: 600,
    byStewardIdWithOrg: 600,
    byWalletAddress: 600,
    byWalletAddressWithOrg: 600,
  },
  identity: {
    resolve: 300, // 5 minutes
  },
  memory: {
    item: 1440, // 24 minutes (unchanged - memory is critical)
    roomRecent: 300, // 5 minutes
    roomContext: 300, // 5 minutes
    conversationContext: 300, // 5 minutes
    conversationSummary: 600, // 10 minutes
    search: 300, // 5 minutes
    patterns: 600, // 10 minutes
    topics: 600, // 10 minutes
  },
  agent: {
    roomContext: 300, // 5 minutes
    info: 300, // 5 minutes - agent info lookup
    characterData: 3600, // 1 hour
    userSession: 300, // 5 minutes
    agentList: 3600, // 1 hour
    agentStats: 300, // 5 minutes
  },
  container: {
    list: 60, // 1 minute (was 30s)
    logs: 60, // 1 minute (was 30s)
    metrics: 300, // 5 minutes
  },
  eliza: {
    roomCharacter: 600, // 10 minutes - room character mappings rarely change
    orgBalance: 30, // 30 seconds - balance changes frequently but we can tolerate slight staleness
  },
  /**
   * Discovery cache TTLs
   */
  discovery: {
    list: 180, // 3 minutes - discovery results
  },
  models: {
    catalog: 3600, // 1 hour - upstream model catalogs change infrequently
  },
  /**
   * Code Agent cache TTLs
   * Short TTLs since sessions are actively used
   */
  codeAgent: {
    session: 60, // 1 minute - session data
    list: 30, // 30 seconds - session list changes frequently
    analytics: 60, // 1 minute - analytics refresh quickly
  },
  /**
   * Admin cache TTLs
   * Moderate TTL since admin status changes infrequently
   */
  admin: {
    status: 300, // 5 minutes - admin status rarely changes
  },
  /**
   * Gallery cache TTLs
   * Moderate TTLs since gallery data changes on upload/delete
   */
  gallery: {
    items: 120, // 2 minutes - gallery items
    stats: 120, // 2 minutes - gallery stats
    collections: 300, // 5 minutes - collections change less often
  },
  mcp: {
    data: 300, // 5 minutes - MCP definitions
  },
  affiliate: {
    data: 3600, // 1 hour - affiliate codes and links rarely change
  },
  walletAuth: {
    user: 30, // 30 seconds - avoid DB upsert on every wallet-authenticated request
  },
  siwe: {
    nonce: 300, // 5 minutes - one-time nonce TTL
  },
  userMetrics: {
    overview: 300, // 5 minutes - live query summary
    daily: 3600, // 1 hour - pre-computed data changes once per day
    retention: 3600, // 1 hour - pre-computed data changes once per day
    activeUsers: 300, // 5 minutes - live query
    signups: 300, // 5 minutes - live query
  },
} as const;

/**
 * Stale-while-revalidate thresholds (in seconds).
 *
 * When data exceeds this age, it's considered stale but still served while revalidating in the background.
 */
export const CacheStaleTTL = {
  org: {
    dashboard: 180, // Serve stale after 3 minutes, revalidate in background
  },
  analytics: {
    overview: 180, // Serve stale after 3 minutes
    breakdown: 300, // Serve stale after 5 minutes
    stats: 300, // Serve stale after 5 minutes
  },
  discovery: {
    list: 120, // Serve stale discovery results after 2 minutes
  },
  models: {
    catalog: 900, // Serve stale model catalogs after 15 minutes
  },
  codeAgent: {
    session: 30, // Serve stale after 30 seconds
    analytics: 30, // Serve stale analytics after 30 seconds
  },
  gallery: {
    items: 60, // Serve stale gallery items after 1 minute
    stats: 60, // Serve stale stats after 1 minute
  },
  userMetrics: {
    overview: 180, // Serve stale overview after 3 minutes
    activeUsers: 180, // Serve stale active users after 3 minutes
  },
} as const;
