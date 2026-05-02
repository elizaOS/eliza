import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * App Discord Automation API
 *
 * GET - Get automation status for an app
 * POST - Enable/update automation for an app
 * DELETE - Disable automation for an app
 */

import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { discordAppAutomationService } from "@/lib/services/discord-automation/app-automation";
import { logger } from "@/lib/utils/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const automationConfigSchema = z.object({
  enabled: z.boolean().optional(),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  autoAnnounce: z.boolean().optional(),
  announceIntervalMin: z.number().min(30).max(1440).optional(),
  announceIntervalMax: z.number().min(30).max(1440).optional(),
  vibeStyle: z.string().max(100).optional(),
  agentCharacterId: z.string().uuid().optional(), // Character voice for posts
});

async function __hono_GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: appId } = await params;

  try {
    const status = await discordAppAutomationService.getAutomationStatus(
      user.organization_id,
      appId,
    );
    return Response.json(status);
  } catch (error) {
    if (error instanceof Error && error.message === "App not found") {
      return Response.json({ error: "App not found" }, { status: 404 });
    }
    logger.error("[Discord Automation] Failed to get status", {
      appId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return Response.json({ error: "Failed to get automation status" }, { status: 500 });
  }
}

async function __hono_POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: appId } = await params;

  let body: z.infer<typeof automationConfigSchema>;
  try {
    const rawBody = await request.json();
    body = automationConfigSchema.parse(rawBody);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "Validation failed", details: error.flatten() },
        { status: 400 },
      );
    }
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Validate interval range - defaults are min=120, max=240
  const DEFAULT_INTERVAL_MIN = 120;
  const DEFAULT_INTERVAL_MAX = 240;

  if (body.announceIntervalMin && body.announceIntervalMax) {
    if (body.announceIntervalMin > body.announceIntervalMax) {
      return Response.json(
        { error: "announceIntervalMin must be less than announceIntervalMax" },
        { status: 400 },
      );
    }
  } else if (body.announceIntervalMax && !body.announceIntervalMin) {
    if (body.announceIntervalMax < DEFAULT_INTERVAL_MIN) {
      return Response.json(
        {
          error: `announceIntervalMax must be >= ${DEFAULT_INTERVAL_MIN} (default min)`,
        },
        { status: 400 },
      );
    }
  } else if (body.announceIntervalMin && !body.announceIntervalMax) {
    if (body.announceIntervalMin > DEFAULT_INTERVAL_MAX) {
      return Response.json(
        {
          error: `announceIntervalMin must be <= ${DEFAULT_INTERVAL_MAX} (default max)`,
        },
        { status: 400 },
      );
    }
  }

  try {
    const app = await discordAppAutomationService.enableAutomation(
      user.organization_id,
      appId,
      body,
    );

    logger.info("[Discord Automation] Automation enabled", {
      appId,
      organizationId: user.organization_id,
    });

    return Response.json({
      success: true,
      discord_automation: app.discord_automation,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "App not found") {
      return Response.json({ error: "App not found" }, { status: 404 });
    }
    if (
      error instanceof Error &&
      (error.message.includes("Discord not connected") ||
        error.message.includes("Guild not found") ||
        error.message.includes("Channel not found"))
    ) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    logger.error("[Discord Automation] Failed to enable", {
      appId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return Response.json({ error: "Failed to enable automation" }, { status: 500 });
  }
}

async function __hono_DELETE(request: Request, { params }: RouteParams): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id: appId } = await params;

  try {
    await discordAppAutomationService.disableAutomation(user.organization_id, appId);

    logger.info("[Discord Automation] Automation disabled", {
      appId,
      organizationId: user.organization_id,
    });

    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "App not found") {
      return Response.json({ error: "App not found" }, { status: 404 });
    }
    logger.error("[Discord Automation] Failed to disable", {
      appId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return Response.json({ error: "Failed to disable automation" }, { status: 500 });
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
