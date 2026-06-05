/**
 * /api/v1/containers
 *
 * Generic Cloud container deploy + read surface. Backs the parent-agent
 * broker's `containers.*` commands and the `build-monetized-app` deploy step
 * ("deploy container with POST /api/v1/containers using `image`"). A deployed
 * container is a row in the `containers` table provisioned by the
 * Hetzner-Docker client; once it reports `running` it is billed daily by the
 * container-billing cron — so an app that earns can fund its own hosting.
 *
 * Endpoints:
 *   - GET    /api/v1/containers        list the org's containers
 *   - GET    /api/v1/containers/quota  container quota + credit runway
 *   - GET    /api/v1/containers/:id    fetch one container
 *   - POST   /api/v1/containers        deploy a container for the org
 *
 * NOTE: provisioning runs the image on the Docker-on-Hetzner node pool, so POST
 * requires that pool (real infra / a Docker-enabled host); the read endpoints
 * work anywhere. The image is gated by the same allowlist as coding containers
 * (shared-infra security) — widen `CODING_CONTAINER_IMAGE_ALLOWLIST` for
 * additional publishers.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { containersEnv } from "@/lib/config/containers-env";
import { isCodingContainerImageAllowed } from "@/lib/services/coding-containers";
import { containersService } from "@/lib/services/containers";
import { getHetznerContainersClient } from "@/lib/services/containers/hetzner-client/client";
import { HetznerClientError } from "@/lib/services/containers/hetzner-client/types";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const CreateContainerSchema = z.object({
  name: z.string().min(1).max(100),
  /** Container image reference, e.g. `ghcr.io/elizaos/my-app:latest`. */
  image: z.string().min(1).max(512),
  /** Stable project key (sticky scheduling/volumes). Defaults to a slug of `name`. */
  projectName: z.string().min(1).max(100).optional(),
  port: z.number().int().positive().max(65535).optional(),
  cpu: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  environmentVars: z.record(z.string(), z.string()).optional(),
  healthCheckPath: z.string().max(256).optional(),
});

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "app"
  );
}

// GET /api/v1/containers — list the org's containers
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const containers = await containersService.listByOrganization(
      user.organization_id,
    );
    return c.json({ success: true, containers });
  } catch (error) {
    return failureResponse(c, error);
  }
});

// GET /api/v1/containers/quota — quota + credit runway (registered before :id)
app.get("/quota", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const quota = await containersService.checkQuota(user.organization_id);
    return c.json({ success: true, quota });
  } catch (error) {
    return failureResponse(c, error);
  }
});

// GET /api/v1/containers/:id — fetch one container
app.get("/:id", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const container = await containersService.getById(
      c.req.param("id"),
      user.organization_id,
    );
    if (!container) {
      return c.json({ success: false, error: "Container not found" }, 404);
    }
    return c.json({ success: true, container });
  } catch (error) {
    return failureResponse(c, error);
  }
});

// POST /api/v1/containers — deploy a container for the org
app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = CreateContainerSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "invalid input",
        },
        400,
      );
    }
    const body = parsed.data;

    // SECURITY: gate the image on the shared container image allowlist so an
    // org cannot run an arbitrary image on the shared node pool.
    const allowlist = containersEnv.codingContainerImageAllowlist();
    if (!isCodingContainerImageAllowed(body.image, allowlist)) {
      logger.warn("[Containers API] image rejected by allowlist", {
        organizationId: user.organization_id,
        image: body.image,
      });
      return c.json(
        {
          success: false,
          code: "CONTAINER_IMAGE_NOT_ALLOWED",
          error: `Image '${body.image}' is not permitted`,
        },
        403,
      );
    }

    // Quota + credit pre-check (the create path also enforces this atomically).
    const quota = await containersService.checkQuota(user.organization_id);
    if (!quota.allowed) {
      return c.json(
        {
          success: false,
          error: quota.error ?? "Container quota exceeded",
          quota,
        },
        402,
      );
    }

    const client = getHetznerContainersClient();
    const container = await client.createContainer({
      name: body.name,
      projectName: body.projectName ?? slugify(body.name),
      organizationId: user.organization_id,
      userId: user.id,
      image: body.image,
      port: body.port ?? 3000,
      desiredCount: 1,
      cpu: body.cpu ?? 1792,
      memoryMb: body.memoryMb ?? 1792,
      ...(body.environmentVars
        ? { environmentVars: body.environmentVars }
        : {}),
      ...(body.healthCheckPath
        ? { healthCheckPath: body.healthCheckPath }
        : {}),
    });

    logger.info("[Containers API] container deploy started", {
      organizationId: user.organization_id,
      containerId: container.id,
      status: container.status,
    });
    return c.json({ success: true, container }, 201);
  } catch (error) {
    if (error instanceof HetznerClientError) {
      const status = error.code === "invalid_input" ? 400 : 502;
      logger.warn("[Containers API] container deploy failed", {
        code: error.code,
        message: error.message,
      });
      return c.json(
        { success: false, code: error.code, error: error.message },
        status,
      );
    }
    return failureResponse(c, error);
  }
});

export default app;
