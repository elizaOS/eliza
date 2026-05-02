/**
 * Hono-native error helper for /api/v1/x/* routes.
 *
 * XServiceError carries a numeric status; we forward that. Anything else
 * goes through the canonical Worker `failureResponse` so the JSON shape
 * matches the rest of the API.
 *
 * NOTE: This module avoids `packages/lib/api/errors` helpers that assume Node-only deps;
 * the Worker bundle stays fetch-native via `failureResponse`.
 */

import type { Context } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { XServiceError } from "@/lib/services/x";

type ErrorWithStatus = Error & { status: number };

function isHttpStatusError(error: unknown): error is ErrorWithStatus {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600;
}

export function xRouteErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof XServiceError || isHttpStatusError(error)) {
    return c.json(
      { success: false, error: error.message },
      error.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500,
    );
  }
  return failureResponse(c, error);
}
