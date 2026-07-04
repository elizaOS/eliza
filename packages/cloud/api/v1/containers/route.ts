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
 *
 * Responses follow the cloud-sdk contract: `{ success, data }` where `data` is
 * a redacted `CloudContainer` (or `CloudContainer[]` for the list). The DTO
 * never emits org-internal or secret fields (environment_vars, deployment_log,
 * metadata, api_key_id, node_id, volume_path, organization_id, user_id).
 *
 * KNOWN FOLLOW-UP SURFACE (Commandment 10 — endpoints the cloud-sdk client
 * already calls that 404 here today; intentionally NOT implemented yet):
 *   - PATCH  /api/v1/containers/:id              updateContainer
 *   - DELETE /api/v1/containers/:id              deleteContainer
 *   - GET    /api/v1/containers/:id/health       getContainerHealth
 *   - GET    /api/v1/containers/:id/metrics      getContainerMetrics
 *   - GET    /api/v1/containers/:id/logs         getContainerLogs
 *   - GET    /api/v1/containers/:id/deployments  getContainerDeployments
 *   - POST   /api/v1/containers/credentials      createContainerCredentials
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { containersEnv } from "@/lib/config/containers-env";
import {
  imageRequiresDigestPin,
  isCodingContainerImageAllowed,
} from "@/lib/services/coding-containers";
import { type Container, containersService } from "@/lib/services/containers";
import { getHetznerContainersClient } from "@/lib/services/containers/hetzner-client/client";
import {
  type ContainerSummary,
  HetznerClientError,
} from "@/lib/services/containers/hetzner-client/types";
import { getOrgImageNamespaces } from "@/lib/services/org-image-namespaces";
import { findReservedEnvKeys } from "@/lib/services/reserved-env-keys";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { CreateContainerSchema } from "./schema";

const app = new Hono<AppEnv>();

// error-policy:J1 every handler across the v1/containers/* dir (this collection
// route plus [id]) has one outermost try/catch that translates exceptions into
// a structured HTTP failure: HetznerClientError maps to a typed 400/404/502/503
// (see handleContainerError in [id]/route.ts), everything else goes through
// failureResponse(c, error). No catch here fabricates a success or empty list;
// a not-found container is an explicit 404 and a listByOrganization failure
// propagates to the 5xx boundary rather than returning [].

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "app"
  );
}

/**
 * Redacted, wire-stable container DTO — the `CloudContainer` shape consumed by
 * `@elizaos/cloud-sdk`. Keep this in exact field agreement with that type:
 * adding a field here means adding it there. Timestamps are ISO strings; secret
 * and infra columns are never included.
 */
interface ContainerDto {
  id: string;
  name: string;
  project_name: string;
  description: string | null;
  load_balancer_url: string | null;
  public_hostname: string | null;
  status: string;
  image_tag: string | null;
  desired_count: number | null;
  cpu: number | null;
  memory: number | null;
  port: number | null;
  health_check_path: string | null;
  last_deployed_at: string | null;
  last_health_check: string | null;
  error_message: string | null;
  billing_status: string | null;
  last_billed_at: string | null;
  next_billing_at: string | null;
  shutdown_warning_sent_at: string | null;
  scheduled_shutdown_at: string | null;
  total_billed: string | null;
  created_at: string;
  updated_at: string;
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isContainerSummary(
  container: Container | ContainerSummary,
): container is ContainerSummary {
  return "projectName" in container;
}

function toContainerDto(container: Container | ContainerSummary): ContainerDto {
  if (isContainerSummary(container)) {
    return {
      id: container.id,
      name: container.name,
      project_name: container.projectName,
      description: null,
      load_balancer_url: container.publicUrl,
      public_hostname: null,
      status: container.status,
      image_tag: container.image,
      desired_count: null,
      cpu: null,
      memory: null,
      port: null,
      health_check_path: null,
      last_deployed_at: null,
      last_health_check: null,
      error_message: container.errorMessage,
      billing_status: null,
      last_billed_at: null,
      next_billing_at: null,
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
      total_billed: null,
      created_at: container.createdAt.toISOString(),
      updated_at: container.updatedAt.toISOString(),
    };
  }

  return {
    id: container.id,
    name: container.name,
    project_name: container.project_name,
    description: container.description,
    load_balancer_url: container.load_balancer_url,
    public_hostname: container.public_hostname,
    status: container.status,
    image_tag: container.image_tag,
    desired_count: container.desired_count,
    cpu: container.cpu,
    memory: container.memory,
    port: container.port,
    health_check_path: container.health_check_path,
    last_deployed_at: isoOrNull(container.last_deployed_at),
    last_health_check: isoOrNull(container.last_health_check),
    error_message: container.error_message,
    billing_status: container.billing_status,
    last_billed_at: isoOrNull(container.last_billed_at),
    next_billing_at: isoOrNull(container.next_billing_at),
    shutdown_warning_sent_at: isoOrNull(container.shutdown_warning_sent_at),
    scheduled_shutdown_at: isoOrNull(container.scheduled_shutdown_at),
    total_billed: container.total_billed,
    created_at: container.created_at.toISOString(),
    updated_at: container.updated_at.toISOString(),
  };
}

// GET /api/v1/containers — list the org's containers
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const containers = await containersService.listByOrganization(
      user.organization_id,
    );
    return c.json({ success: true, data: containers.map(toContainerDto) });
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
    return c.json({ success: true, data: toContainerDto(container) });
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

    // SECURITY (#9853): reject caller-supplied reserved/managed env keys so an
    // org cannot shadow the platform-injected DB DSN, cloud API token, or
    // metered-identity keys on this container. The app-deploy route strips the
    // same denylist; this route previously forwarded environmentVars raw.
    if (body.environmentVars) {
      const reserved = findReservedEnvKeys(Object.keys(body.environmentVars));
      if (reserved.length > 0) {
        logger.warn("[Containers API] reserved env keys rejected", {
          organizationId: user.organization_id,
          reserved,
        });
        return c.json(
          {
            success: false,
            code: "RESERVED_ENV_KEYS",
            error: `environmentVars may not set platform-reserved keys: ${reserved.join(", ")}`,
          },
          400,
        );
      }
    }

    const projectName = body.projectName ?? slugify(body.name);

    // Idempotency: if a non-terminal container already exists for this
    // (organization_id, project_name), return it instead of provisioning a
    // duplicate. project_name is the stable, sticky deploy key.
    const existing = await containersService.getActiveByProjectName(
      user.organization_id,
      projectName,
    );
    if (existing) {
      return c.json({ success: true, data: toContainerDto(existing) }, 200);
    }

    // SECURITY: gate the image on the shared container image allowlist so an
    // org cannot run an arbitrary image on the shared node pool. When the
    // platform-wide list denies, consult the org's OWN operator-granted
    // namespace extension (organizations.settings.allowed_image_namespaces) —
    // additive and fail-closed, so one org's grant never widens another's gate.
    const allowlist = containersEnv.codingContainerImageAllowlist();
    const imageAllowed =
      isCodingContainerImageAllowed(body.image, allowlist) ||
      isCodingContainerImageAllowed(
        body.image,
        await getOrgImageNamespaces(user.organization_id),
      );
    if (!imageAllowed) {
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

    // SECURITY (opt-in): when the digest-pin gate is armed, reject mutable
    // refs so an allowed repo cannot swap bytes behind a tag after this check.
    if (
      imageRequiresDigestPin(
        body.image,
        containersEnv.requireDigestPinnedImages(),
      )
    ) {
      logger.warn("[Containers API] image rejected: digest pin required", {
        organizationId: user.organization_id,
        image: body.image,
      });
      return c.json(
        {
          success: false,
          code: "CONTAINER_IMAGE_NOT_DIGEST_PINNED",
          error: `Image '${body.image}' must be pinned to a full sha256 digest (e.g. repo@sha256:<64 hex>)`,
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
      projectName,
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
    return c.json({ success: true, data: toContainerDto(container) }, 201);
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
