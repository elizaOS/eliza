/**
 * Game Agent Card Endpoint
 *
 * Returns the Feed game's A2A agent card for discovery.
 * WHY: A2A and other agent protocols expect a well-known URL for agent discovery;
 * next.config rewrites /.well-known/agent-card.json → this route so agents find us at the standard path.
 * Content is the in-memory feedAgentCard (no DB); per-agent cards are at /api/agents/{id}/.well-known/agent-card.
 *
 * @see agent-patch-plan.md Phase 3.1
 */

import { feedAgentCard } from "@feed/a2a";
import { withErrorHandling } from "@feed/api";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/game/card
 * Returns the Feed game agent card
 */
export const GET = withErrorHandling(async function GET() {
  return NextResponse.json(feedAgentCard, {
    headers: {
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      "Content-Type": "application/json",
    },
  });
});
