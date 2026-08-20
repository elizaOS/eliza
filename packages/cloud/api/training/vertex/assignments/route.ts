// Handles cloud API training vertex assignments route traffic with route-local auth expectations.
import { Hono } from "hono";
import { requireAdmin, requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { vertexModelRegistryService } from "@/lib/services/vertex-model-registry";
import type { VertexTuningSlot } from "@/lib/services/vertex-tuning";
import type { AppEnv } from "@/types/cloud-worker-env";

const VERTEX_TUNING_SLOTS = [
  "should_respond",
  "response_handler",
  "action_planner",
  "planner",
  "response",
  "media_description",
] as const satisfies readonly VertexTuningSlot[];

function parseScope(value: unknown): "global" | "organization" | "user" {
  return value === "global" || value === "organization" || value === "user"
    ? value
    : "organization";
}

function parseSlot(value: unknown): VertexTuningSlot | undefined {
  return typeof value === "string"
    ? VERTEX_TUNING_SLOTS.find((slot) => slot === value)
    : undefined;
}

class VertexAssignmentActiveError extends Error {
  constructor(message = "Invalid active") {
    super(message);
    this.name = "VertexAssignmentActiveError";
  }
}

function parseActiveOnlyQuery(searchParams: URLSearchParams): boolean {
  const requested = searchParams.getAll("active");
  if (requested.length > 1) {
    throw new VertexAssignmentActiveError();
  }
  const raw = requested[0];
  if (raw == null || raw === "") {
    return true;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new VertexAssignmentActiveError();
}

async function ensureGlobalAccess(request: Request): Promise<void> {
  const admin = await requireAdmin(request);
  if (admin.role !== "super_admin") {
    throw new Error(
      "Global tuned-model assignments require super-admin access.",
    );
  }
}

async function __hono_GET(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { searchParams } = new URL(request.url);
    const rawScope = searchParams.get("scope");
    if (
      rawScope !== null &&
      rawScope !== "" &&
      rawScope !== "global" &&
      rawScope !== "organization" &&
      rawScope !== "user"
    ) {
      return Response.json({ error: "Invalid scope." }, { status: 400 });
    }
    const scope = parseScope(rawScope);
    const rawSlot = searchParams.get("slot");
    const slot = parseSlot(rawSlot);
    let activeOnly: boolean;
    try {
      activeOnly = parseActiveOnlyQuery(searchParams);
      // error-policy:J1 invalid query values become an HTTP 400 response.
    } catch (activeError) {
      if (activeError instanceof VertexAssignmentActiveError) {
        return Response.json({ error: activeError.message }, { status: 400 });
      }
      throw activeError;
    }

    if (rawSlot && !slot) {
      return Response.json({ error: "Invalid slot." }, { status: 400 });
    }

    const assignments = await vertexModelRegistryService.listVisibleAssignments(
      {
        organizationId: user.organization_id,
        userId: user.id,
      },
      {
        scope: searchParams.get("scope") ? scope : undefined,
        slot,
        activeOnly,
      },
    );

    return Response.json({ assignments });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to list tuned-model assignments",
      },
      { status: 500 },
    );
  }
}

async function __hono_POST(request: Request) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<
      string,
      unknown
    >;
    const scope = parseScope(body.scope);

    if (scope === "global") {
      await ensureGlobalAccess(request);
    }

    const slot = parseSlot(body.slot);
    const tunedModelId =
      typeof body.tunedModelId === "string" ? body.tunedModelId : undefined;

    if (typeof body.slot === "string" && !slot) {
      return Response.json({ error: "Invalid slot." }, { status: 400 });
    }

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
      slot,
      tunedModelId,
      organizationId: scope === "global" ? undefined : user.organization_id,
      userId: scope === "user" ? user.id : undefined,
      assignedByUserId: user.id,
      metadata:
        body.metadata &&
        typeof body.metadata === "object" &&
        !Array.isArray(body.metadata)
          ? (body.metadata as Record<string, unknown>)
          : undefined,
    });

    return Response.json({ assignment }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to activate tuned-model assignment";
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
    const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<
      string,
      unknown
    >;
    const scope = parseScope(body.scope);

    if (scope === "global") {
      await ensureGlobalAccess(request);
    }

    const slot = parseSlot(body.slot);
    if (typeof body.slot === "string" && !slot) {
      return Response.json({ error: "Invalid slot." }, { status: 400 });
    }

    if (!slot) {
      return Response.json(
        {
          error: "slot is required.",
        },
        { status: 400 },
      );
    }

    const deactivatedCount =
      await vertexModelRegistryService.deactivateAssignment({
        scope,
        slot,
        organizationId: scope === "global" ? undefined : user.organization_id,
        userId: scope === "user" ? user.id : undefined,
      });

    return Response.json({ deactivatedCount });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to deactivate tuned-model assignment";
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
