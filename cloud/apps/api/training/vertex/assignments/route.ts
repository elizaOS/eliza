import { Hono } from "hono";
import { requireAdmin, requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { vertexModelRegistryService } from "@/lib/services/vertex-model-registry";
import type { AppEnv } from "@/types/cloud-worker-env";

function parseScope(value: unknown): "global" | "organization" | "user" {
  return value === "global" || value === "organization" || value === "user"
    ? value
    : "organization";
}

async function ensureGlobalAccess(request: Request): Promise<void> {
  const admin = await requireAdmin(request);
  if (admin.role !== "super_admin") {
    throw new Error("Global tuned-model assignments require super-admin access.");
  }
}

async function __hono_GET(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { searchParams } = new URL(request.url);
    const scope = parseScope(searchParams.get("scope"));
    const slot = searchParams.get("slot") || undefined;
    const activeOnly = searchParams.get("active") !== "false";

    const assignments = await vertexModelRegistryService.listVisibleAssignments(
      {
        organizationId: user.organization_id,
        userId: user.id,
      },
      {
        scope: searchParams.get("scope") ? scope : undefined,
        slot: slot as any,
        activeOnly,
      },
    );

    return Response.json({ assignments });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to list tuned-model assignments",
      },
      { status: 500 },
    );
  }
}

async function __hono_POST(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const scope = parseScope(body.scope);

    if (scope === "global") {
      await ensureGlobalAccess(request);
    }

    const slot = typeof body.slot === "string" ? body.slot : undefined;
    const tunedModelId = typeof body.tunedModelId === "string" ? body.tunedModelId : undefined;

    if (!slot || !tunedModelId) {
      return Response.json(
        {
          error: "slot and tunedModelId are required.",
        },
        { status: 400 },
      );
    }

    const assignment = await vertexModelRegistryService.activateAssignment({
      scope,
      slot: slot as any,
      tunedModelId,
      organizationId: scope === "global" ? undefined : user.organization_id,
      userId: scope === "user" ? user.id : undefined,
      assignedByUserId: user.id,
      metadata:
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    });

    return Response.json({ assignment }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to activate tuned-model assignment";
    return Response.json(
      {
        error: message,
      },
      { status: message.includes("super-admin") ? 403 : 500 },
    );
  }
}

async function __hono_DELETE(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const scope = parseScope(body.scope);

    if (scope === "global") {
      await ensureGlobalAccess(request);
    }

    const slot = typeof body.slot === "string" ? body.slot : undefined;
    if (!slot) {
      return Response.json(
        {
          error: "slot is required.",
        },
        { status: 400 },
      );
    }

    const deactivatedCount = await vertexModelRegistryService.deactivateAssignment({
      scope,
      slot: slot as any,
      organizationId: scope === "global" ? undefined : user.organization_id,
      userId: scope === "user" ? user.id : undefined,
    });

    return Response.json({ deactivatedCount });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to deactivate tuned-model assignment";
    return Response.json(
      {
        error: message,
      },
      { status: message.includes("super-admin") ? 403 : 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
__hono_app.post("/", async (c) => __hono_POST(c.req.raw));
__hono_app.delete("/", async (c) => __hono_DELETE(c.req.raw));
export default __hono_app;
