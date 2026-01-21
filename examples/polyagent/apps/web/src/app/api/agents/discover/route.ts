/**
 * Agent Discovery Endpoint
 *
 * @route GET /api/agents/discover - Discover available agents
 * @access Public
 *
 * @description
 * Discovers agents based on filters including skills and domains.
 */

import type { AgentDiscoveryFilter } from "@babylon/agents";
import { AgentStatus, AgentType, agentRegistry } from "@babylon/agents";
import { logger } from "@babylon/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Parse query parameters
  const typesParam = searchParams.get("types");
  const skillsParam = searchParams.get("skills");
  const domainsParam = searchParams.get("domains");
  const matchMode = (searchParams.get("matchMode") as "any" | "all") || "all";
  const search = searchParams.get("search") || undefined;
  const limit = Number.parseInt(searchParams.get("limit") || "50", 10);
  const offset = Number.parseInt(searchParams.get("offset") || "0", 10);

  // Build discovery filter
  const filter: AgentDiscoveryFilter = {
    types: typesParam
      ? (typesParam
          .split(",")
          .filter((t) =>
            Object.values(AgentType).includes(t as AgentType),
          ) as AgentType[])
      : undefined,
    statuses: [AgentStatus.ACTIVE, AgentStatus.INITIALIZED],
    requiredSkills: skillsParam
      ? skillsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    requiredDomains: domainsParam
      ? domainsParam
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean)
      : undefined,
    matchMode,
    search,
    limit,
    offset,
  };

  logger.info(
    "Agent discovery request",
    {
      filter: {
        ...filter,
        types: filter.types?.join(","),
        requiredSkills: filter.requiredSkills?.join(","),
        requiredDomains: filter.requiredDomains?.join(","),
      },
    },
    "AgentDiscovery",
  );

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";

  // Use local registry for discovery
  const agents = await agentRegistry.discoverAgents(filter);

  const agentCards = agents.map((agent) => ({
    version: "1.0" as const,
    agentId: agent.agentId,
    name: agent.name,
    description: agent.systemPrompt,
    type: agent.type,
    status: agent.status,
    trustLevel: agent.trustLevel,
    endpoints: {
      card: `${baseUrl}/api/agents/${agent.agentId}/card`,
    },
    capabilities: agent.capabilities,
    authentication: {
      required: false,
      methods: [],
    },
  }));

  logger.info(
    `Discovered ${agentCards.length} agents`,
    {
      totalFound: agentCards.length,
      skillsCount: filter.requiredSkills?.length || 0,
      domainsCount: filter.requiredDomains?.length || 0,
    },
    "AgentDiscovery",
  );

  return NextResponse.json(
    {
      agents: agentCards,
      total: agentCards.length,
      filter: {
        types: filter.types,
        skills: filter.requiredSkills,
        domains: filter.requiredDomains,
        matchMode: filter.matchMode,
      },
    },
    { status: 200 },
  );
}
