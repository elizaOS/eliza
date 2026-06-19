/**
 * Admin-only endpoint to trigger a game tick for DAG tracing.
 *
 * @route POST /api/admin/dag-traces/trigger-tick
 * @access Admin
 */

import { requireAdmin, successResponse, withErrorHandling } from "@feed/api";
import { executeGameTick } from "@feed/engine";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { ensureEngineServices } from "@/lib/engine/ensure-engine-services";

export const maxDuration = 300;

export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  ensureEngineServices();

  logger.info("Admin-triggered game tick for DAG tracing", {}, "DagTrace");

  const startMs = Date.now();
  const result = await executeGameTick();
  const durationMs = Date.now() - startMs;

  return successResponse({
    success: true,
    durationMs,
    result,
  });
});
