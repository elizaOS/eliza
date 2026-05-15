import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { vertexModelRegistryService } from "@/lib/services/vertex-model-registry";
import type { VertexTuningScope, VertexTuningSlot } from "@/lib/services/vertex-tuning";
import type { AppEnv } from "@/types/cloud-worker-env";

const VERTEX_TUNING_SLOTS = [
  "should_respond",
  "response_handler",
  "action_planner",
  "planner",
  "response",
  "media_description",
] as const satisfies readonly VertexTuningSlot[];

function parseScope(value: unknown): VertexTuningScope | undefined {
  return value === "global" || value === "organization" || value === "user" ? value : undefined;
}

function parseSlot(value: unknown): VertexTuningSlot | undefined {
  return typeof value === "string" ? VERTEX_TUNING_SLOTS.find((slot) => slot === value) : undefined;
}

async function __hono_GET(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { searchParams } = new URL(request.url);
    const scope = parseScope(searchParams.get("scope"));
    const rawSlot = searchParams.get("slot");
    const slot = parseSlot(rawSlot);

    if (rawSlot && !slot) {
      return Response.json({ error: "Invalid slot." }, { status: 400 });
    }

    const [models, assignments, resolved] = await Promise.all([
      vertexModelRegistryService.listVisibleTunedModels(
        {
          organizationId: user.organization_id,
          userId: user.id,
        },
        {
          scope,
          slot,
        },
      ),
      vertexModelRegistryService.listVisibleAssignments(
        {
          organizationId: user.organization_id,
          userId: user.id,
        },
        {
          scope,
          slot,
          activeOnly: true,
        },
      ),
      vertexModelRegistryService.resolveModelPreferences({
        organizationId: user.organization_id,
        userId: user.id,
      }),
    ]);

    return Response.json({
      models,
      assignments,
      resolvedModelPreferences: resolved.modelPreferences,
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to list tuned models",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
export default __hono_app;
