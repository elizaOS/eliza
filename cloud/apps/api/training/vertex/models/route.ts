import { Hono } from "hono";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { vertexModelRegistryService } from "@/lib/services/vertex-model-registry";
import type { AppEnv } from "@/types/cloud-worker-env";

async function __hono_GET(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { searchParams } = new URL(request.url);
    const scope =
      searchParams.get("scope") === "global" ||
      searchParams.get("scope") === "organization" ||
      searchParams.get("scope") === "user"
        ? (searchParams.get("scope") as "global" | "organization" | "user")
        : undefined;
    const slot = searchParams.get("slot") || undefined;

    const [models, assignments, resolved] = await Promise.all([
      vertexModelRegistryService.listVisibleTunedModels(
        {
          organizationId: user.organization_id,
          userId: user.id,
        },
        {
          scope,
          slot: slot as any,
        },
      ),
      vertexModelRegistryService.listVisibleAssignments(
        {
          organizationId: user.organization_id,
          userId: user.id,
        },
        {
          scope,
          slot: slot as any,
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
