/**
 * GET /api/v1/oauth/status
 *
 * Returns the connection status for the legacy services surface (Google,
 * Twilio, Blooio) for the authenticated organization.
 */

import { Hono } from "hono";
import { failureResponse, ApiError as WorkerApiError } from "@/lib/api/cloud-worker-errors";
import { ApiError } from "@/lib/api/errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { oauthService } from "@/lib/services/oauth";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface LegacyServiceStatus {
  id: string;
  name: string;
  connected: boolean;
  error?: string;
}

async function getGoogleStatus(
  organizationId: string,
  userId: string,
): Promise<LegacyServiceStatus> {
  try {
    const connections = await oauthService.listConnections({
      organizationId,
      userId,
      platform: "google",
    });

    return {
      id: "google",
      name: "Google",
      connected: connections.some((connection) => connection.status === "active"),
    };
  } catch (error) {
    return {
      id: "google",
      name: "Google",
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getTwilioStatus(organizationId: string): Promise<LegacyServiceStatus> {
  try {
    const status = await twilioAutomationService.getConnectionStatus(organizationId);

    return {
      id: "twilio",
      name: "Twilio",
      connected: status.connected,
    };
  } catch (error) {
    return {
      id: "twilio",
      name: "Twilio",
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getBlooioStatus(organizationId: string): Promise<LegacyServiceStatus> {
  try {
    const status = await blooioAutomationService.getConnectionStatus(organizationId);

    return {
      id: "blooio",
      name: "Blooio",
      connected: status.connected,
    };
  } catch (error) {
    return {
      id: "blooio",
      name: "Blooio",
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  let organizationId: string | undefined;

  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    organizationId = user.organization_id;

    const services = await Promise.all([
      getGoogleStatus(user.organization_id, user.id),
      getTwilioStatus(user.organization_id),
      getBlooioStatus(user.organization_id),
    ]);

    return c.json({ services });
  } catch (error) {
    logger.error("[OAuth Status] Failed to build legacy status response", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof WorkerApiError) {
      return failureResponse(c, error);
    }
    if (error instanceof ApiError) {
      return c.json(error.toJSON(), error.status as 400);
    }

    return c.json({ error: "Failed to fetch OAuth status" }, 500);
  }
});

export default app;
