/**
 * Official A2A Agent Card Endpoint
 * Standard location: /.well-known/agent-card.json
 */

import { feedAgentCard } from "@feed/a2a";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(feedAgentCard, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const dynamic = "force-dynamic";
