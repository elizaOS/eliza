// Handles v1 cloud API v1 eliza agents agentid environment route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { findReservedManagedElizaEnvKeys } from "@/lib/services/managed-eliza-config";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "PATCH, OPTIONS";

const envKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name");

const envValueSchema = z.union([z.string().max(20_000), z.null()]);

const environmentPatchSchema = z.object({
  environmentVars: z.record(envKeySchema, envValueSchema),
});

async function __hono_PATCH(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const body = await request.json().catch(() => null);

    const parsed = environmentPatchSchema.safeParse(body);
    if (!parsed.success) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Invalid request data",
            details: parsed.error.issues,
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }
    const reservedKeys = findReservedManagedElizaEnvKeys(
      Object.keys(parsed.data.environmentVars),
    );
    if (reservedKeys.length > 0) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Reserved environment variables cannot be patched",
            reservedKeys,
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }

    const agent = await elizaSandboxService.getAgentForWrite(
      agentId,
      user.organization_id,
    );
    if (!agent) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    const existing =
      agent.environment_vars && typeof agent.environment_vars === "object"
        ? (agent.environment_vars as Record<string, string>)
        : {};
    const next = { ...existing };
    const updatedKeys: string[] = [];
    const removedKeys: string[] = [];

    for (const [key, value] of Object.entries(parsed.data.environmentVars)) {
      if (value === null) {
        delete next[key];
        removedKeys.push(key);
      } else {
        next[key] = value;
        updatedKeys.push(key);
      }
    }

    const updated = await elizaSandboxService.updateAgentEnvironment(
      agent.id,
      user.organization_id,
      next,
    );
    if (!updated) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    logger.info("[agent-environment-api] Agent environment updated", {
      agentId,
      orgId: user.organization_id,
      updatedKeys,
      removedKeys,
      status: updated.status,
      executionTier: updated.execution_tier,
    });

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          agentId,
          updatedKeys,
          removedKeys,
          status: updated.status,
          executionTier: updated.execution_tier,
          needsRestart:
            updated.status === "running" && updated.execution_tier !== "shared",
        },
      }),
      CORS_METHODS,
    );
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.patch("/", async (c) =>
  __hono_PATCH(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);

export default __hono_app;

export const __agentEnvironmentTestHooks = {
  handlePatch: __hono_PATCH,
};
