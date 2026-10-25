// Handles v1 cloud API v1 eliza agents agentid environment route traffic with route-local auth expectations.

import { errorToResponse } from "@elizaos/cloud-shared/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@elizaos/cloud-shared/lib/auth";
import { elizaSandboxService } from "@elizaos/cloud-shared/lib/services/eliza-sandbox";
import { findReservedManagedElizaEnvKeys } from "@elizaos/cloud-shared/lib/services/managed-eliza-config";
import {
  applyCorsHeaders,
  handleCorsOptions,
} from "@elizaos/cloud-shared/lib/services/proxy/cors";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

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

    const updatedKeys: string[] = [];
    const removedKeys: string[] = [];
    for (const [key, value] of Object.entries(parsed.data.environmentVars)) {
      (value === null ? removedKeys : updatedKeys).push(key);
    }

    // The patch is applied to the stored variables under the agent's
    // lifecycle lock, never to a copy read before it.
    const updated = await elizaSandboxService.patchAgentEnvironment(
      agentId,
      user.organization_id,
      parsed.data.environmentVars,
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
