/**
 * Game Agent Card Endpoint
 *
 * Returns the Babylon game's A2A agent card for discovery.
 * WHY: A2A and other agent protocols expect a well-known URL for agent discovery;
 * next.config rewrites /.well-known/agent-card.json → this route so agents find us at the standard path.
 * Content is the in-memory babylonAgentCard (no DB); per-agent cards are at /api/agents/{id}/.well-known/agent-card.
 *
 * @see agent-patch-plan.md Phase 3.1
 */

import { babylonAgentCard } from '@babylon/a2a';
import { withErrorHandling } from '@babylon/api';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/game/card
 * Returns the Babylon game agent card
 */
export const GET = withErrorHandling(async function GET() {
  return NextResponse.json(babylonAgentCard, {
    headers: {
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      'Content-Type': 'application/json',
    },
  });
});
