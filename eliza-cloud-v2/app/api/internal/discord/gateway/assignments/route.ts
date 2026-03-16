/**
 * Gateway Discord Assignments API
 *
 * Returns bot assignments for a gateway pod.
 * Called by the gateway-discord service to get bots to connect.
 */

import { NextRequest, NextResponse } from "next/server";
import { withInternalAuth } from "@/lib/auth/internal-api";
import { discordConnectionsRepository } from "@/db/repositories";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

export const GET = withInternalAuth(async (request: NextRequest) => {
  const podName = request.nextUrl.searchParams.get("pod");
  // Validate pod name: alphanumeric with hyphens, max 253 chars (K8s limit)
  if (!podName || !/^[a-zA-Z0-9-]+$/.test(podName) || podName.length > 253) {
    return NextResponse.json(
      { error: "Invalid pod name" },
      { status: 400 },
    );
  }

  // Current and max connection counts to prevent over-claiming
  // Validate to prevent NaN causing silent failures (NaN < NaN is always false)
  const currentCountRaw = parseInt(
    request.nextUrl.searchParams.get("current") ?? "0",
    10,
  );
  const maxCountRaw = parseInt(
    request.nextUrl.searchParams.get("max") ?? "100",
    10,
  );

  // Use safe defaults if values are invalid
  const currentCount = Number.isNaN(currentCountRaw) ? 0 : currentCountRaw;
  const maxCount = Number.isNaN(maxCountRaw) ? 100 : maxCountRaw;

  logger.info("[Gateway Assignments] Fetching assignments", {
    podName,
    currentCount,
    maxCount,
  });

  const assignments = await discordConnectionsRepository.getAssignmentsForPod(
    podName,
    currentCount < maxCount, // Only claim new if we have capacity
  );

  logger.info("[Gateway Assignments] Returning assignments", {
    podName,
    count: assignments.length,
  });

  return NextResponse.json({ assignments });
});
