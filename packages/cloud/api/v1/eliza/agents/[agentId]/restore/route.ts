// Handles v1 cloud API v1 eliza agents agentid restore route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { CONTAINER_BACKED_EXECUTION_TIERS } from "@/db/schemas/agent-sandboxes";
import { errorToResponse, ValidationError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
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

    // This primary read is a route-level admission snapshot, not a lock or a
    // CAS. The service rechecks tenant ownership, but it does not fence these
    // four fields across lifecycle work; a concurrent transition can still
    // win here until the inner restore path gains its own CAS.
    if (
      !CONTAINER_BACKED_EXECUTION_TIERS.some(
        (tier) => tier === agent.execution_tier,
      )
    ) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Agent restore requires a container-backed execution tier",
          },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }
    if (agent.pool_status !== null) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Agent restore cannot target pool-owned capacity",
          },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }
    if (agent.deleted_at !== null) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Agent restore cannot target a deleted agent",
          },
          { status: 409 },
        ),
        CORS_METHODS,
      );
    }
    if (agent.deletion_attempt_id !== null) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error:
              "Agent restore cannot start while agent deletion is in progress",
          },
          { status: 409 },
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
    // `errorToResponse` deliberately redacts the message (a restore push can
    // carry bridge hosts / DB details), so an unhandled throw here reaches the
    // caller as a bare 500 "An unexpected error occurred" and, without this,
    // left NO trace server-side. Restore pushes state over the network to a
    // live agent —
    // an unreachable bridge, a rejected push, or a misconfigured agent-router
    // binding all land here — so the operator-visible record is the only way to
    // tell an infrastructure failure from a bug. Log before redacting.
    logger.error("Agent restore failed", {
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    });
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
