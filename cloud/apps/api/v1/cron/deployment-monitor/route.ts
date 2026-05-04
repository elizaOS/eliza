import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Deployment monitor cron handler.
 *
 * Polls in-flight Hetzner-Docker containers (status `deploying`) and
 * flips them to `running` once the Docker container reports healthy or
 * to `failed` once it exits/dies. Runs every minute.
 *
 * This handler is Node-only (transitively imports `ssh2`) and lives on
 * the Node sidecar that hosts the container control plane. The Hono
 * codegen for Cloudflare Workers will skip it (no `from "hono"` import);
 * the sidecar's Next.js entry serves it.
 */

import { verifyCronSecret } from "@/lib/api/cron-auth";
import { getHetznerContainersClient } from "@/lib/services/containers/hetzner-client";
import { logger } from "@/lib/utils/logger";

async function handleDeploymentMonitor(request: Request) {
  const authError = verifyCronSecret(request, "[Deployment Monitor]");
  if (authError) return authError;

  try {
    const result = await getHetznerContainersClient().monitorInflight();

    logger.info("[Deployment Monitor] tick", result);

    return Response.json({
      success: true,
      data: { ...result, timestamp: new Date().toISOString() },
    });
  } catch (error) {
    logger.error(
      "[Deployment Monitor] failed:",
      error instanceof Error ? error.message : String(error),
    );
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Monitor failed",
      },
      { status: 500 },
    );
  }
}

async function __hono_GET(request: Request) {
  return handleDeploymentMonitor(request);
}

async function __hono_POST(request: Request) {
  return handleDeploymentMonitor(request);
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) => __hono_GET(c.req.raw));
__hono_app.post("/", async (c) => __hono_POST(c.req.raw));
export default __hono_app;
