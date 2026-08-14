/**
 * Finalizes one personal Shared→Dedicated activation. The server re-imports
 * the authoritative Shared history into the healthy target before atomically
 * marking that target active, so phone and future app sessions cannot switch
 * early or lose the working Shared fallback on failure.
 */

import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  finalizePersonalTierUpgradeCutover,
  findActivePersonalDedicatedTarget,
  findLiveTierUpgradeTarget,
} from "@/lib/services/agent-tier-upgrade-target";
import { readPersonalElizaCutover } from "@/lib/services/eliza-agent-config";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  coordinateSharedCutoverCommit,
  coordinateSharedCutoverRelease,
  coordinateSharedCutoverSeal,
} from "@/lib/services/shared-runtime/conversation-coordinator";
import {
  personalDedicatedAgentApiBase,
  personalSharedAgentId,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";
const CUTOVER_SEAL_LEASE_MS = 60_000;
const bodySchema = z.object({ dedicatedAgentId: z.string().uuid() });

function json(body: unknown, status = 200): Response {
  return applyCorsHeaders(Response.json(body, { status }), CORS_METHODS);
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    // error-policy:J3 malformed transport input is returned to the caller as
    // an explicit validation failure, never treated as a valid empty payload.
    return null;
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // error-policy:J3 an unreadable import receipt is an explicit failed
    // cutover; Shared stays sealed only for this request's bounded lease.
    return null;
  }
}

const app = new Hono<AppEnv>();

app.options("/", () => handleCorsOptions(CORS_METHODS));

app.post("/", async (c) => {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(c.req.raw);
    const parsed = bodySchema.safeParse(await readJsonBody(c.req.raw));
    if (!parsed.success) {
      return json(
        {
          success: false,
          code: "invalid_dedicated_cutover",
          error: "A valid Dedicated target id is required.",
        },
        400,
      );
    }

    const sourceAgentId = personalSharedAgentId({
      userId: user.id,
      organizationId: user.organization_id,
    });
    if (c.req.param("agentId") !== sourceAgentId) {
      return json({ success: false, error: "Agent not found" }, 404);
    }
    const active = await findActivePersonalDedicatedTarget(
      user.organization_id,
      sourceAgentId,
    );
    if (
      active?.id === parsed.data.dedicatedAgentId &&
      active.user_id === user.id
    ) {
      const marker = readPersonalElizaCutover(
        active.agent_config as Record<string, unknown> | null,
      );
      const activeBase = personalDedicatedAgentApiBase(
        active,
        c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
      );
      if (marker && activeBase) {
        return json({
          success: true,
          data: {
            personalElizaId: sourceAgentId,
            activeAgentId: active.id,
            runtime: "dedicated" as const,
            apiBase: activeBase,
            importedMessages: marker.sharedMessageCount,
          },
        });
      }
    }
    const target = await findLiveTierUpgradeTarget(
      user.organization_id,
      sourceAgentId,
    );
    if (
      !target ||
      target.id !== parsed.data.dedicatedAgentId ||
      target.user_id !== user.id ||
      target.status !== "running"
    ) {
      return json(
        {
          success: false,
          code: "dedicated_not_healthy",
          error:
            "Dedicated is not healthy yet. Shared remains active; try again when setup finishes.",
        },
        409,
      );
    }

    const conversationNamespace = c.env.SHARED_RUNTIME_CONVERSATIONS;
    if (
      !conversationNamespace ||
      typeof conversationNamespace.getByName !== "function"
    ) {
      return json(
        {
          success: false,
          code: "shared_history_unavailable",
          error:
            "Shared history is temporarily unavailable. Shared remains active.",
        },
        503,
      );
    }

    const base = personalDedicatedAgentApiBase(
      target,
      c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
    );
    if (!base) {
      return json(
        {
          success: false,
          code: "dedicated_not_reachable",
          error:
            "Dedicated has no reachable endpoint yet. Shared remains active.",
        },
        409,
      );
    }
    const sealToken = crypto.randomUUID();
    const history = await coordinateSharedCutoverSeal(
      sourceAgentId,
      sourceAgentId,
      { token: sealToken, leaseMs: CUTOVER_SEAL_LEASE_MS },
      { namespace: conversationNamespace },
    );
    let activated = false;
    try {
      if (history.some((message) => !message.id)) {
        return json(
          {
            success: false,
            code: "shared_history_identity_missing",
            error:
              "Shared history could not be verified for an exact transfer. Shared remains active.",
          },
          503,
        );
      }
      if (history.length > 0) {
        const authorization = c.req.header("authorization");
        const apiKey = c.req.header("x-api-key");
        const response = await fetch(
          `${base}/api/conversations/${encodeURIComponent(sourceAgentId)}/import`,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              ...(authorization ? { Authorization: authorization } : {}),
              ...(apiKey ? { "X-API-Key": apiKey } : {}),
            },
            body: JSON.stringify({
              messages: history.map((message) => ({
                sourceId: message.id,
                role: message.role,
                text: message.content,
                ...(typeof message.createdAt === "number"
                  ? { timestamp: message.createdAt }
                  : {}),
              })),
            }),
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (!response.ok) {
          return json(
            {
              success: false,
              code: "dedicated_history_import_failed",
              error:
                "History did not finish moving to Dedicated. Shared remains active.",
            },
            503,
          );
        }
        const receipt = (await readJsonResponse(response)) as {
          complete?: unknown;
          inserted?: unknown;
          skipped?: unknown;
          sourceMessageCount?: unknown;
        } | null;
        if (
          receipt?.complete !== true ||
          receipt.sourceMessageCount !== history.length ||
          typeof receipt.inserted !== "number" ||
          typeof receipt.skipped !== "number" ||
          receipt.inserted + receipt.skipped !== history.length
        ) {
          return json(
            {
              success: false,
              code: "dedicated_history_receipt_invalid",
              error:
                "Dedicated did not confirm the complete history import. Shared remains active.",
            },
            503,
          );
        }
      }

      const activeTarget = await finalizePersonalTierUpgradeCutover({
        organizationId: user.organization_id,
        userId: user.id,
        sourceAgentId,
        dedicatedAgentId: target.id,
        sharedMessageCount: history.length,
      });
      activated = true;
      await coordinateSharedCutoverCommit(
        sourceAgentId,
        sourceAgentId,
        sealToken,
        { namespace: conversationNamespace },
      );
      return json({
        success: true,
        data: {
          personalElizaId: sourceAgentId,
          activeAgentId: activeTarget.id,
          runtime: "dedicated" as const,
          apiBase: base,
          importedMessages: history.length,
        },
      });
    } finally {
      if (!activated) {
        await coordinateSharedCutoverRelease(
          sourceAgentId,
          sourceAgentId,
          sealToken,
          { namespace: conversationNamespace },
        );
      }
    }
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
});

export default app;
