/**
 * Official A2A Agent Card Endpoint
 * Standard location: /.well-known/agent-card.json
 */

import { babylonAgentCard } from '@babylon/a2a';
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(babylonAgentCard, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export const dynamic = 'force-dynamic';
