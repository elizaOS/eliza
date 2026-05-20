/**
 * Official A2A Agent Card Endpoint
 *
 * Returns agent card following official A2A protocol spec
 * from https://a2a-protocol.org
 *
 * Standard location: /.well-known/agent-card.json
 */

import { feedAgentCard } from '@feed/a2a';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * GET /.well-known/agent-card.json
 *
 * Returns the official A2A AgentCard with:
 * - Protocol version 0.3.0
 * - 10 Feed game skills
 * - Official A2A methods (message/send, tasks/*)
 * - Capabilities and metadata
 */
export async function GET() {
  return NextResponse.json(feedAgentCard, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
    },
  });
}
