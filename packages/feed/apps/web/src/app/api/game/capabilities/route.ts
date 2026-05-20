/**
 * Game Capabilities Endpoint
 *
 * Returns detailed capabilities of the Babylon game
 * Used for agent discovery and capability matching
 *
 * @see agent-patch-plan.md Phase 3.1
 */

import { babylonAgentCard } from '@babylon/a2a';
import { withErrorHandling } from '@babylon/api';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/game/capabilities
 * Returns detailed game capabilities
 */
export const GET = withErrorHandling(async function GET() {
  const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const capabilities = {
    name: babylonAgentCard.name,
    version: babylonAgentCard.version,
    description: babylonAgentCard.description,
    protocolVersion: babylonAgentCard.protocolVersion,

    // Agent capabilities from card
    capabilities: babylonAgentCard.capabilities,

    // Available protocols
    protocols: {
      a2a: {
        endpoint: babylonAgentCard.url,
        supported: true,
        version: babylonAgentCard.protocolVersion,
        transport: babylonAgentCard.preferredTransport,
      },
      mcp: {
        endpoint: `${BASE_URL}/api/mcp`,
        supported: true,
        version: '1.0',
      },
    },

    // Skills from A2A card
    skills: babylonAgentCard.skills,

    // Market types
    marketTypes: [
      {
        type: 'prediction',
        description: 'Prediction markets on future events',
        actions: ['place_bet', 'close_position', 'view_market'],
      },
      {
        type: 'perpetuals',
        description: 'Perpetual prediction markets on company performance',
        actions: ['trade', 'long', 'short', 'close_position'],
      },
    ],

    // Authentication methods from security schemes
    authentication: {
      required: (babylonAgentCard.security?.length ?? 0) > 0,
      methods: babylonAgentCard.securitySchemes
        ? Object.values(babylonAgentCard.securitySchemes).map(
            (scheme) => scheme.type
          )
        : [],
    },

    // Input/output modes
    inputModes: babylonAgentCard.defaultInputModes,
    outputModes: babylonAgentCard.defaultOutputModes,

    // Additional game features
    features: {
      realTimePricing: true,
      socialFeed: true,
      agentAutonomy: true,
      reputationSystem: true,
      onChainRegistry: true,
      streaming: babylonAgentCard.capabilities.streaming,
      pushNotifications: babylonAgentCard.capabilities.pushNotifications,
    },
  };

  return NextResponse.json(capabilities, {
    headers: {
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      'Content-Type': 'application/json',
    },
  });
});
