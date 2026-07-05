// Handles v1 cloud API v1 eliza agents agentid restore route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse, ValidationError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

const restoreSchema = z.object({
  backupId: z.string().uuid().optional(),
});

/**
 * POST /api/v1/eliza/agents/[agentId]/restore
 * Restore a sandbox from a specific backup (or the latest backup).
 *
 * If the sandbox is running, pushes state directly.
 * If the sandbox is stopped, re-provisions and restores.
 */
async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    // Every field is optional, so a bodyless POST is the canonical
    // "restore the latest backup" call — treat an empty body as `{}`.
    // Malformed non-empty JSON is the caller's fault: a typed 400, not the
    // unguarded SyntaxError that errorToResponse maps to a 500.
    const rawBody = await request.text();
    let body: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        // error-policy:J3 untrusted request body — malformed JSON becomes a typed 400 "invalid" result
        throw new ValidationError("Invalid JSON body");
      }
    }

    const parsed = restoreSchema.safeParse(body);
    if (!parsed.success) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Invalid request",
            details: parsed.error.issues,
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }

    const result = await elizaSandboxService.restore(
      agentId,
      user.organization_id,
      parsed.data.backupId,
    );

    if (!result.success) {
      // A backupId that exists but belongs to a different agent must be
      // indistinguishable from one that does not exist (same 404 + message):
      // the service's ownership check is not a server fault (was a 500), and
      // a distinct response would make backup ids a cross-agent/cross-org
      // existence oracle (gated ≠ owned).
      if (result.error === "Backup does not belong to this agent") {
        return applyCorsHeaders(
          Response.json(
            { success: false, error: "No backup found" },
            { status: 404 },
          ),
          CORS_METHODS,
        );
      }

      const status =
        result.error === "Agent not found"
          ? 404
          : result.error === "No backup found"
            ? 404
            : result.error ===
                "Stopped agents can only restore the latest backup"
              ? 409
              : 500;

      return applyCorsHeaders(
        Response.json({ success: false, error: result.error }, { status }),
        CORS_METHODS,
      );
    }

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          restoredFromBackupId: result.backup?.id,
          snapshotType: result.backup?.snapshot_type,
          createdAt: result.backup?.created_at,
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
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
