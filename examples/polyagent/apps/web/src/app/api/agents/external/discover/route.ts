/**
 * Agent Discovery Endpoint
 *
 * GET /api/agents/external/discover
 *
 * Allows external agents to discover other agents registered on the platform
 * Returns agent capabilities, endpoints, and trust levels
 *
 * @see src/lib/services/agent-registry.service.ts
 */

import type { AgentRegistration, TrustLevel } from "@polyagent/agents";
import { AgentStatus, AgentType, agentRegistry } from "@polyagent/agents";
import { checkRateLimitAsync, RATE_LIMIT_CONFIGS } from "@polyagent/api";
import { logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

// Discovery filter type
interface DiscoveryFilter {
  types?: AgentType[];
  statuses?: AgentStatus[];
  minTrustLevel?: TrustLevel;
  requiredCapabilities?: string[];
  requiredSkills?: string[];
  requiredDomains?: string[];
  matchMode?: "all" | "any";
  limit?: number;
  offset?: number;
}

// Query parameter validation
const DiscoveryQuerySchema = z.object({
  types: z.string().optional(), // Comma-separated: USER_CONTROLLED,NPC,EXTERNAL
  statuses: z.string().optional(), // Comma-separated: ACTIVE,PAUSED
  minTrustLevel: z.coerce.number().min(0).max(4).optional(),
  capabilities: z.string().optional(), // Comma-separated: text-generation,analysis
  skills: z.string().optional(), // Comma-separated OASF skills
  domains: z.string().optional(), // Comma-separated OASF domains
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  offset: z.coerce.number().min(0).optional().default(0),
});

// Body validation for POST-based discovery
const DiscoveryBodySchema = z.object({
  types: z.array(z.nativeEnum(AgentType)).optional(),
  statuses: z.array(z.nativeEnum(AgentStatus)).optional(),
  minTrustLevel: z.coerce.number().min(0).max(4).optional(),
  requiredCapabilities: z.array(z.string()).optional(),
  requiredSkills: z.array(z.string()).optional(),
  requiredDomains: z.array(z.string()).optional(),
  matchMode: z.enum(["all", "any"]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

/**
 * Authenticate the request using API key from Authorization header
 * Returns the agent registration if authenticated, null otherwise
 */
async function authenticateRequest(
  req: NextRequest,
): Promise<AgentRegistration | null> {
  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const apiKey = authHeader.substring(7); // Remove 'Bearer ' prefix

  return agentRegistry.verifyExternalAgentApiKey(apiKey);
}

/**
 * GET /api/agents/external/discover
 *
 * Discover agents based on filters
 */
export async function GET(req: NextRequest) {
  // Authenticate the request
  const agent = await authenticateRequest(req);

  if (!agent) {
    return NextResponse.json(
      {
        success: false,
        error: "Unauthorized",
        message: "Invalid or missing API key",
      },
      { status: 401 },
    );
  }

  // Rate limit check - use agent's discoveryRateLimit or default to 60/min
  // Clamp to valid bounds: min 1, max 1000 requests per minute
  const rawRateLimit = agent.discoveryMetadata?.limits?.rateLimit ?? 60;
  const agentRateLimit = Math.min(Math.max(rawRateLimit, 1), 1000);
  const rateLimitConfig = {
    ...RATE_LIMIT_CONFIGS.EXTERNAL_AGENT_DISCOVER,
    maxRequests: agentRateLimit,
  };

  const rateLimitResult = await checkRateLimitAsync(
    agent.agentId,
    rateLimitConfig,
  );

  if (!rateLimitResult.allowed) {
    logger.warn(
      "External agent discovery rate limit exceeded",
      {
        agentId: agent.agentId,
        retryAfter: rateLimitResult.retryAfter,
        limit: agentRateLimit,
      },
      "ExternalAgentDiscovery",
    );

    return NextResponse.json(
      {
        success: false,
        error: "Too Many Requests",
        message: "Rate limit exceeded for discovery requests",
        retryAfter: rateLimitResult.retryAfter,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimitResult.retryAfter ?? 60),
          "X-RateLimit-Limit": String(agentRateLimit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining ?? 0),
        },
      },
    );
  }

  // Parse query parameters
  const { searchParams } = new URL(req.url);
  const query = {
    types: searchParams.get("types") || undefined,
    statuses: searchParams.get("statuses") || undefined,
    minTrustLevel: searchParams.get("minTrustLevel") || undefined,
    capabilities: searchParams.get("capabilities") || undefined,
    skills: searchParams.get("skills") || undefined,
    domains: searchParams.get("domains") || undefined,
    limit: searchParams.get("limit") || undefined,
    offset: searchParams.get("offset") || undefined,
  };

  const validatedResult = DiscoveryQuerySchema.safeParse(query);
  if (!validatedResult.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Validation error",
        details: validatedResult.error.issues,
      },
      { status: 400 },
    );
  }

  const validated = validatedResult.data;

  // Build discovery filter
  const filter: DiscoveryFilter = {};

  // Filter by agent types
  if (validated.types) {
    const types = validated.types.split(",").map((t) => t.trim());
    filter.types = types.filter((t) =>
      Object.values(AgentType).includes(t as AgentType),
    ) as AgentType[];
  }

  // Filter by statuses
  if (validated.statuses) {
    const statuses = validated.statuses.split(",").map((s) => s.trim());
    filter.statuses = statuses.filter((s) =>
      Object.values(AgentStatus).includes(s as AgentStatus),
    ) as AgentStatus[];
  }

  // Filter by minimum trust level
  if (validated.minTrustLevel !== undefined) {
    filter.minTrustLevel = validated.minTrustLevel as TrustLevel;
  }

  // Filter by capabilities (actions)
  if (validated.capabilities) {
    filter.requiredCapabilities = validated.capabilities
      .split(",")
      .map((c) => c.trim());
  }

  // Filter by OASF skills
  if (validated.skills) {
    filter.requiredSkills = validated.skills.split(",").map((s) => s.trim());
  }

  // Filter by OASF domains
  if (validated.domains) {
    filter.requiredDomains = validated.domains.split(",").map((d) => d.trim());
  }

  // Pagination
  filter.limit = validated.limit;
  filter.offset = validated.offset;

  // Discover agents using agent registry
  const agents = await agentRegistry.discoverAgents(filter);

  // Transform agents for external API response
  const results = agents.map((discoveredAgent) => ({
    agentId: discoveredAgent.agentId,
    name: discoveredAgent.name,
    type: discoveredAgent.type,
    status: discoveredAgent.status,
    trustLevel: discoveredAgent.trustLevel,
    capabilities: discoveredAgent.capabilities,
    discoveryMetadata: discoveredAgent.discoveryMetadata,
    endpoints: discoveredAgent.discoveryMetadata?.endpoints,
    lastActiveAt: discoveredAgent.lastActiveAt,
  }));

  return NextResponse.json({
    success: true,
    agents: results,
    pagination: {
      limit: validated.limit,
      offset: validated.offset,
      total: results.length,
    },
    filters: filter,
  });
}

/**
 * POST /api/agents/external/discover
 *
 * Advanced discovery with complex filters (body-based)
 */
export async function POST(req: NextRequest) {
  // Authenticate the request
  const agent = await authenticateRequest(req);

  if (!agent) {
    return NextResponse.json(
      {
        success: false,
        error: "Unauthorized",
        message: "Invalid or missing API key",
      },
      { status: 401 },
    );
  }

  // Rate limit check - use agent's discoveryRateLimit or default to 60/min
  // Clamp to valid bounds: min 1, max 1000 requests per minute
  const rawRateLimit = agent.discoveryMetadata?.limits?.rateLimit ?? 60;
  const agentRateLimit = Math.min(Math.max(rawRateLimit, 1), 1000);
  const rateLimitConfig = {
    ...RATE_LIMIT_CONFIGS.EXTERNAL_AGENT_DISCOVER,
    maxRequests: agentRateLimit,
  };

  const rateLimitResult = await checkRateLimitAsync(
    agent.agentId,
    rateLimitConfig,
  );

  if (!rateLimitResult.allowed) {
    logger.warn(
      "External agent discovery rate limit exceeded",
      {
        agentId: agent.agentId,
        retryAfter: rateLimitResult.retryAfter,
        limit: agentRateLimit,
      },
      "ExternalAgentDiscovery",
    );

    return NextResponse.json(
      {
        success: false,
        error: "Too Many Requests",
        message: "Rate limit exceeded for discovery requests",
        retryAfter: rateLimitResult.retryAfter,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimitResult.retryAfter ?? 60),
          "X-RateLimit-Limit": String(agentRateLimit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining ?? 0),
        },
      },
    );
  }

  // Parse request body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "Validation error",
        message: "Invalid JSON body",
      },
      { status: 400 },
    );
  }

  const validatedBodyResult = DiscoveryBodySchema.safeParse(body);
  if (!validatedBodyResult.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Validation error",
        details: validatedBodyResult.error.issues,
      },
      { status: 400 },
    );
  }

  const validatedBody = validatedBodyResult.data;

  // Discover agents using agent registry
  const agents = await agentRegistry.discoverAgents(validatedBody);

  // Transform agents for external API response
  const results = agents.map((discoveredAgent) => ({
    agentId: discoveredAgent.agentId,
    name: discoveredAgent.name,
    type: discoveredAgent.type,
    status: discoveredAgent.status,
    trustLevel: discoveredAgent.trustLevel,
    capabilities: discoveredAgent.capabilities,
    discoveryMetadata: discoveredAgent.discoveryMetadata,
    endpoints: discoveredAgent.discoveryMetadata?.endpoints,
    lastActiveAt: discoveredAgent.lastActiveAt,
  }));

  return NextResponse.json({
    success: true,
    agents: results,
    pagination: {
      limit: validatedBody.limit,
      offset: validatedBody.offset,
      total: results.length,
    },
    filters: validatedBody,
  });
}
