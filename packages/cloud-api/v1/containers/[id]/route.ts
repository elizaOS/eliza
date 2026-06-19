/**
 * /api/v1/containers/:id
 *
 * Per-container lifecycle verbs that back the parent-agent broker's
 * `containers.*` commands and the survival loop's "turn it off to stop the
 * bleed" lever. The collection route (../route.ts) owns GET/list/quota and POST
 * deploy; this leaf owns the mutations:
 *
 *   - PATCH  /api/v1/containers/:id   restart | setEnv | scale (action-discriminated)
 *   - DELETE /api/v1/containers/:id   stop (preserve row) or delete (remove row)
 *
 * Each verb maps 1:1 to an org-scoped HetznerContainersClient method; the
 * client throws `HetznerClientError` (404/400/503/...) which is mapped to HTTP
 * here. Billing keys off `status === "running"`, so stop/delete halt billing
 * immediately and restart/setEnv pause it (status → "deploying") until the
 * monitor cron flips the container back to "running".
 *
 * NOTE: the mutations run over SSH to the Docker-on-Hetzner node pool, so they
 * require that pool (real infra). Against the API-only mock they surface the
 * client's typed errors.
 */

import { type Context, Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { getHetznerContainersClient } from "@/lib/services/containers/hetzner-client/client";
import { HetznerClientError } from "@/lib/services/containers/hetzner-client/types";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const PatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("restart") }),
  z.object({
    action: z.literal("setEnv"),
    environmentVars: z.record(z.string(), z.string()),
  }),
  z.object({
    action: z.literal("scale"),
    desiredCount: z.number().int().positive(),
  }),
]);

function hetznerErrorStatus(
  code: HetznerClientError["code"],
): 400 | 404 | 502 | 503 {
  switch (code) {
    case "container_not_found":
      return 404;
    case "invalid_input":
      return 400;
    case "ssh_unreachable":
    case "no_capacity":
      return 503;
    default:
      return 502;
  }
}

function handleContainerError(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof HetznerClientError) {
    logger.warn("[Containers API] container mutation failed", {
      code: error.code,
      message: error.message,
    });
    return c.json(
      { success: false, code: error.code, error: error.message },
      hetznerErrorStatus(error.code),
    );
  }
  return failureResponse(c, error);
}

// PATCH /api/v1/containers/:id — restart | setEnv | scale
app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing container id" }, 400);
    }
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "invalid input",
        },
        400,
      );
    }
    const action = parsed.data;
    const client = getHetznerContainersClient();

    if (action.action === "restart") {
      const container = await client.restartContainer(id, user.organization_id);
      return c.json({ success: true, container });
    }
    if (action.action === "setEnv") {
      const container = await client.setEnv(
        id,
        user.organization_id,
        action.environmentVars,
      );
      return c.json({ success: true, container });
    }
    // scale — setScale returns void (only desiredCount === 1 is supported), so
    // re-read the container to return a uniform ContainerSummary.
    await client.setScale(id, user.organization_id, action.desiredCount);
    const container = await client.getContainer(id, user.organization_id);
    if (!container) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }
    return c.json({ success: true, container });
  } catch (error) {
    return handleContainerError(c, error);
  }
});

const DeleteSchema = z.object({
  /** `stop` preserves the row (billing off); `delete` removes it. */
  mode: z.enum(["stop", "delete"]).optional(),
  /** Destructive: also rm -rf the host volume / delete the hcloud volume. */
  purgeVolume: z.coerce.boolean().optional(),
});

// DELETE /api/v1/containers/:id — stop (preserve row) or delete (remove row)
app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) {
      return c.json({ success: false, error: "Missing container id" }, 400);
    }
    const parsed = DeleteSchema.safeParse({
      mode: c.req.query("mode"),
      purgeVolume: c.req.query("purgeVolume"),
    });
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "invalid input",
        },
        400,
      );
    }
    const mode = parsed.data.mode ?? "delete";
    const purgeVolume = parsed.data.purgeVolume ?? false;
    const client = getHetznerContainersClient();

    if (mode === "stop") {
      const container = await client.stopContainer(id, user.organization_id, {
        purgeVolume,
      });
      logger.info("[Containers API] container stopped", {
        organizationId: user.organization_id,
        containerId: id,
        purgeVolume,
      });
      return c.json({ success: true, container });
    }

    await client.deleteContainer(id, user.organization_id, { purgeVolume });
    logger.info("[Containers API] container deleted", {
      organizationId: user.organization_id,
      containerId: id,
      purgeVolume,
    });
    return c.json({ success: true, deleted: true });
  } catch (error) {
    return handleContainerError(c, error);
  }
});

export default app;
