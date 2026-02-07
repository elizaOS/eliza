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
    stats: (orgId: string, dateRange: string) =>
      `analytics:stats:${orgId}:${dateRange}:v1`,
    userBreakdown: (orgId: string, params: string) =>
      `analytics:userbreakdown:${orgId}:${params}:v1`,
    projections: (orgId: string, daysAhead: number) =>
      `analytics:projections:${orgId}:${daysAhead}:v1`,
    timeSeries: (
      orgId: string,
      granularity: string,
      start: string,
      end: string,
    ) => `analytics:timeseries:${orgId}:${granularity}:${start}:${end}:v1`,
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
    /** Cache app by API key ID (for fast auth lookups) */
    byApiKeyId: (apiKeyId: string) => `app:apikey:${apiKeyId}:v1`,
    /** Pattern for invalidating all app cache */
    pattern: () => `app:*`,
  },
  session: {
    /** Cache session token validation results */
    privy: (tokenHash: string) => `session:privy:${tokenHash}:v1`,
    /** Cache user data by session token */
    user: (tokenHash: string) => `session:user:${tokenHash}:v1`,
    pattern: () => `session:*`,
  },
  user: {
    byEmail: (email: string) => `user:email:${email}:v1`,
    pattern: () => `user:*`,
  },
  memory: {
    item: (orgId: string, memoryId: string) => `memory:${orgId}:${memoryId}:v1`,
    roomRecent: (orgId: string, roomId: string) =>
      `memory:${orgId}:room:${roomId}:recent:v1`,
    roomContext: (orgId: string, roomId: string, depth: number) =>
      `memory:${orgId}:room:${roomId}:context:${depth}:v1`,
    search: (orgId: string, queryHash: string) =>
      `memory:${orgId}:search:${queryHash}:v1`,
    conversationContext: (orgId: string, convId: string, depth: number) =>
      `memory:${orgId}:conv:${convId}:${depth}:v1`,
    conversationSummary: (orgId: string, convId: string) =>
      `memory:${orgId}:conv:${convId}:summary:v1`,
    patterns: (orgId: string, analysisType: string) =>
      `memory:${orgId}:patterns:${analysisType}:v1`,
    topics: (orgId: string, timeRange: string) =>
      `memory:${orgId}:topics:${timeRange}:v1`,
    orgPattern: (orgId: string) => `memory:${orgId}:*`,
    roomPattern: (orgId: string, roomId: string) =>
      `memory:${orgId}:room:${roomId}:*`,
  },
  agent: {
    roomContext: (roomId: string) => `agent:room:${roomId}:context:v1`,
    characterData: (agentId: string) => `agent:${agentId}:character:v1`,
    userSession: (entityId: string) => `agent:user:${entityId}:session:v1`,
    agentList: (orgId: string, filterHash: string) =>
      `agent:list:${orgId}:${filterHash}:v1`,
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
  /**
   * Code Agent cache keys
   * Used for caching session data and analytics
   */
  codeAgent: {
    session: (sessionId: string) => `code_agent:session:${sessionId}:v1`,
    list: (orgId: string) => `code_agent:list:${orgId}:v1`,
    analytics: (orgId: string, range: string) =>
      `code_agent:analytics:${orgId}:${range}:v1`,
    pattern: (orgId: string) => `code_agent:*:${orgId}:*`,
  },
  /**
   * Admin cache keys
   * Used for caching admin status lookups to reduce DB load
   */
  admin: {
    /** Cache admin status by wallet address (isAdmin + role) */
    status: (walletAddress: string) =>
      `admin:status:${walletAddress.toLowerCase()}:v1`,
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
    stats: (orgId: string, userId: string) =>
      `gallery:stats:${orgId}:${userId}:v1`,
    /** Cache collections by org/user */
    collections: (orgId: string, userId: string) =>
      `gallery:collections:${orgId}:${userId}:v1`,
    /** Pattern for invalidating all gallery cache for an org */
    orgPattern: (orgId: string) => `gallery:*:${orgId}:*`,
    /** Pattern for invalidating all gallery cache for a user */
    userPattern: (orgId: string, userId: string) =>
      `gallery:*:${orgId}:${userId}:*`,
  },
  /**
   * N8N Workflow cache keys
   * Used for caching workflow lists to reduce DB load
   */
  n8nWorkflows: {
    /** Cache workflow list by org and filter options */
    list: (orgId: string, filterHash: string) =>
      `n8n:workflows:${orgId}:${filterHash}:v1`,
    /** Cache single workflow by ID */
    workflow: (workflowId: string) => `n8n:workflow:${workflowId}:v1`,
    /** Pattern for invalidating all workflow cache for an org */
    orgPattern: (orgId: string) => `n8n:workflows:${orgId}:*`,
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
    byId: 600, // 10 minutes - app details
    byApiKeyId: 600, // 10 minutes - app lookup by API key
  },
  session: {
    privy: 300, // 5 minutes - Privy token validation
    user: 300, // 5 minutes - User data by session
  },
  user: {
    byEmail: 600, // 10 minutes (was 300s)
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
  /**
   * N8N Workflow cache TTLs
   * Moderate TTLs since workflows change on user action
   */
  n8nWorkflows: {
    list: 60, // 1 minute - workflow list
    workflow: 120, // 2 minutes - single workflow details
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
  codeAgent: {
    session: 30, // Serve stale after 30 seconds
    analytics: 30, // Serve stale analytics after 30 seconds
  },
  gallery: {
    items: 60, // Serve stale gallery items after 1 minute
    stats: 60, // Serve stale stats after 1 minute
  },
} as const;
