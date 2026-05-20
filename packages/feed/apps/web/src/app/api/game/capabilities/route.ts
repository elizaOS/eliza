/**
 * Game Capabilities Endpoint
 *
 * Returns detailed capabilities of the Feed game
 * Used for agent discovery and capability matching
 *
 * @see agent-patch-plan.md Phase 3.1
 */

import { feedAgentCard } from "@feed/a2a";
import { withErrorHandling } from "@feed/api";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/game/capabilities
 * Returns detailed game capabilities
 */
export const GET = withErrorHandling(async function GET() {
  const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const capabilities = {
    name: feedAgentCard.name,
    version: feedAgentCard.version,
    description: feedAgentCard.description,
    protocolVersion: feedAgentCard.protocolVersion,

    // Agent capabilities from card
    capabilities: feedAgentCard.capabilities,

    // Available protocols
    protocols: {
      a2a: {
        endpoint: feedAgentCard.url,
        supported: true,
        version: feedAgentCard.protocolVersion,
        transport: feedAgentCard.preferredTransport,
      },
      mcp: {
        endpoint: `${BASE_URL}/api/mcp`,
        supported: true,
        version: "1.0",
      },
    },

    // Skills from A2A card
    skills: feedAgentCard.skills,

    // Market types
    marketTypes: [
      {
        type: "prediction",
        description: "Prediction markets on future events",
        actions: ["place_bet", "close_position", "view_market"],
      },
      {
        type: "perpetuals",
        description: "Perpetual prediction markets on company performance",
        actions: ["trade", "long", "short", "close_position"],
      },
    ],

    // Authentication methods from security schemes
    authentication: {
      required: (feedAgentCard.security?.length ?? 0) > 0,
      methods: feedAgentCard.securitySchemes
        ? Object.values(feedAgentCard.securitySchemes).map(
            (scheme) => scheme.type,
          )
        : [],
    },

    // Input/output modes
    inputModes: feedAgentCard.defaultInputModes,
    outputModes: feedAgentCard.defaultOutputModes,

    // Additional game features
    features: {
      realTimePricing: true,
      socialFeed: true,
      agentAutonomy: true,
      reputationSystem: true,
      onChainRegistry: true,
      streaming: feedAgentCard.capabilities.streaming,
      pushNotifications: feedAgentCard.capabilities.pushNotifications,
    },
  };

  return NextResponse.json(capabilities, {
    headers: {
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      "Content-Type": "application/json",
    },
  });
});
