/**
 * GET /api/v1/knowledge/check
 *
 * Lightweight endpoint to check if an agent has knowledge documents.
 * Does not spin up a full runtime - uses direct database query.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKey } from "@/lib/auth";
import { memoriesRepository } from "@/db/repositories/agents/memories";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

async function handleGET(req: NextRequest) {
  const authResult = await requireAuthOrApiKey(req);

  const characterId = req.nextUrl.searchParams.get("characterId");
  if (!characterId) {
    return NextResponse.json(
      { error: "characterId is required" },
      { status: 400 },
    );
  }

  // Direct database query - no runtime needed
  const documentCount = await memoriesRepository.countByType(
    characterId,
    "documents",
    characterId, // roomId = agentId in knowledge plugin pattern
  );

  return NextResponse.json({
    hasDocuments: documentCount > 0,
    count: documentCount,
  });
}

export const GET = withRateLimit(handleGET, RateLimitPresets.STANDARD);
