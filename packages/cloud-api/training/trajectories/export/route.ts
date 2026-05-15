import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { llmTrajectoryService, type TrajectoryExportOptions } from "@/lib/services/llm-trajectory";
import type { AppEnv } from "@/types/cloud-worker-env";

function parseDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function resolveExportOptions(input: Record<string, unknown>): TrajectoryExportOptions {
  return {
    model: typeof input.model === "string" ? input.model : undefined,
    purpose: typeof input.purpose === "string" ? input.purpose : undefined,
    startDate: typeof input.startDate === "string" ? parseDate(input.startDate) : undefined,
    endDate: typeof input.endDate === "string" ? parseDate(input.endDate) : undefined,
    limit: typeof input.limit === "number" ? input.limit : undefined,
  };
}

function buildJsonlResponse(jsonl: string) {
  const lineCount = jsonl.trim().length > 0 ? jsonl.trim().split("\n").length : 0;
  return Response.json({
    jsonl,
    lineCount,
  });
}

async function __hono_GET(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { searchParams } = new URL(request.url);
    const options = resolveExportOptions({
      model: searchParams.get("model"),
      purpose: searchParams.get("purpose"),
      startDate: searchParams.get("startDate"),
      endDate: searchParams.get("endDate"),
      limit: searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined,
    });
    const jsonl = await llmTrajectoryService.exportAsTrainingJSONL(user.organization_id, options);
    return buildJsonlResponse(jsonl);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to export trajectories",
      },
      { status: 500 },
    );
  }
}

async function __hono_POST(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const options = resolveExportOptions(body);
    const jsonl = await llmTrajectoryService.exportAsTrainingJSONL(user.organization_id, options);
    return buildJsonlResponse(jsonl);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to export trajectories",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
__hono_app.post("/", async (c) => __hono_POST(c.req.raw));
export default __hono_app;
