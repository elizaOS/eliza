/**
 * Serves authenticated training-trajectory exports for one organization.
 * Query and JSON-body limits are validated before the export service can read rows.
 */
import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  llmTrajectoryService,
  type TrajectoryExportOptions,
} from "@/lib/services/llm-trajectory";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_EXPORT_LIMIT = 10_000;

type ExportLimitResult =
  | { ok: true; value: number | undefined }
  | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidExportLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_EXPORT_LIMIT;
}

function parseQueryLimit(value: string | null): ExportLimitResult {
  if (value === null || value === "") return { ok: true, value: undefined };
  if (!/^[1-9]\d*$/.test(value)) return { ok: false };

  const parsed = Number(value);
  return isValidExportLimit(parsed)
    ? { ok: true, value: parsed }
    : { ok: false };
}

function parseBodyLimit(input: Record<string, unknown>): ExportLimitResult {
  if (!("limit" in input)) return { ok: true, value: undefined };
  const value = input.limit;
  return typeof value === "number" && isValidExportLimit(value)
    ? { ok: true, value }
    : { ok: false };
}

function invalidLimitResponse() {
  return Response.json({ error: "Invalid limit" }, { status: 400 });
}

function invalidRequestBodyResponse() {
  return Response.json({ error: "Invalid request body" }, { status: 400 });
}

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function resolveExportOptions(
  input: Record<string, unknown>,
  limit: number | undefined,
): TrajectoryExportOptions {
  return {
    model: typeof input.model === "string" ? input.model : undefined,
    purpose: typeof input.purpose === "string" ? input.purpose : undefined,
    startDate:
      typeof input.startDate === "string"
        ? parseDate(input.startDate)
        : undefined,
    endDate:
      typeof input.endDate === "string" ? parseDate(input.endDate) : undefined,
    limit,
  };
}

function buildJsonlResponse(jsonl: string) {
  const lineCount =
    jsonl.trim().length > 0 ? jsonl.trim().split("\n").length : 0;
  return Response.json({
    jsonl,
    lineCount,
  });
}

async function __hono_GET(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { searchParams } = new URL(request.url);
    const parsedLimit = parseQueryLimit(searchParams.get("limit"));
    if (!parsedLimit.ok) return invalidLimitResponse();

    const options = resolveExportOptions(
      {
        model: searchParams.get("model"),
        purpose: searchParams.get("purpose"),
        startDate: searchParams.get("startDate"),
        endDate: searchParams.get("endDate"),
      },
      parsedLimit.value,
    );
    const jsonl = await llmTrajectoryService.exportAsTrainingJSONL(
      user.organization_id,
      options,
    );
    return buildJsonlResponse(jsonl);
  } catch (error) {
    // error-policy:J1 route boundary translates failures into structured HTTP errors.
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to export trajectories",
      },
      { status: 500 },
    );
  }
}

async function __hono_POST(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // error-policy:J3 malformed JSON is an explicit invalid request, never a default export.
      return invalidRequestBodyResponse();
    }
    if (!isRecord(body)) return invalidRequestBodyResponse();

    const parsedLimit = parseBodyLimit(body);
    if (!parsedLimit.ok) return invalidLimitResponse();

    const options = resolveExportOptions(body, parsedLimit.value);
    const jsonl = await llmTrajectoryService.exportAsTrainingJSONL(
      user.organization_id,
      options,
    );
    return buildJsonlResponse(jsonl);
  } catch (error) {
    // error-policy:J1 route boundary translates failures into structured HTTP errors.
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to export trajectories",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
__hono_app.post("/", async (c) => __hono_POST(c.req.raw));
export default __hono_app;
