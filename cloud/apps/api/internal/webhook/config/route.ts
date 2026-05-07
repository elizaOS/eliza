import { Hono } from "hono";
import { z } from "zod";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { userCharactersRepository } from "@/db/repositories/characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  BLOOIO_API_KEY,
  BLOOIO_FROM_NUMBER,
  BLOOIO_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_APP_SECRET,
  WHATSAPP_BUSINESS_PHONE,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
} from "@/lib/constants/secrets";
import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../_auth";

const platformSchema = z.enum(["telegram", "blooio", "twilio", "whatsapp"]);

const querySchema = z.object({
  agentId: z.string().uuid(),
  platform: platformSchema,
});

type WebhookConfig = {
  agentId: string;
  botToken?: string;
  webhookSecret?: string;
  apiKey?: string;
  blooioWebhookSecret?: string;
  fromNumber?: string;
  accountSid?: string;
  authToken?: string;
  phoneNumber?: string;
  accessToken?: string;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
  businessPhone?: string;
};

const app = new Hono<AppEnv>();

async function resolveOrganizationId(agentId: string): Promise<string | null> {
  const sandboxOrganizationId = await agentSandboxesRepository.findOrganizationIdById(agentId);
  if (sandboxOrganizationId) {
    return sandboxOrganizationId;
  }

  return (await userCharactersRepository.findOrganizationIdById(agentId)) ?? null;
}

async function getSecret(organizationId: string, name: string): Promise<string | undefined> {
  return (await secretsService.get(organizationId, name)) ?? undefined;
}

async function buildWebhookConfig(
  organizationId: string,
  agentId: string,
  platform: z.infer<typeof platformSchema>,
): Promise<WebhookConfig | null> {
  switch (platform) {
    case "telegram": {
      const [botToken, webhookSecret] = await Promise.all([
        getSecret(organizationId, TELEGRAM_BOT_TOKEN),
        getSecret(organizationId, TELEGRAM_WEBHOOK_SECRET),
      ]);
      if (!botToken || !webhookSecret) return null;
      return { agentId, botToken, webhookSecret };
    }
    case "blooio": {
      const [apiKey, blooioWebhookSecret, fromNumber] = await Promise.all([
        getSecret(organizationId, BLOOIO_API_KEY),
        getSecret(organizationId, BLOOIO_WEBHOOK_SECRET),
        getSecret(organizationId, BLOOIO_FROM_NUMBER),
      ]);
      if (!apiKey || !blooioWebhookSecret) return null;
      return { agentId, apiKey, blooioWebhookSecret, fromNumber };
    }
    case "twilio": {
      const [accountSid, authToken, phoneNumber] = await Promise.all([
        getSecret(organizationId, TWILIO_ACCOUNT_SID),
        getSecret(organizationId, TWILIO_AUTH_TOKEN),
        getSecret(organizationId, TWILIO_PHONE_NUMBER),
      ]);
      if (!accountSid || !authToken || !phoneNumber) return null;
      return { agentId, accountSid, authToken, phoneNumber };
    }
    case "whatsapp": {
      const [accessToken, phoneNumberId, appSecret, verifyToken, businessPhone] = await Promise.all(
        [
          getSecret(organizationId, WHATSAPP_ACCESS_TOKEN),
          getSecret(organizationId, WHATSAPP_PHONE_NUMBER_ID),
          getSecret(organizationId, WHATSAPP_APP_SECRET),
          getSecret(organizationId, WHATSAPP_VERIFY_TOKEN),
          getSecret(organizationId, WHATSAPP_BUSINESS_PHONE),
        ],
      );
      if (!accessToken || !phoneNumberId || !appSecret || !verifyToken) return null;
      return { agentId, accessToken, phoneNumberId, appSecret, verifyToken, businessPhone };
    }
  }
}

app.get("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const query = querySchema.parse({
      agentId: c.req.query("agentId"),
      platform: c.req.query("platform"),
    });

    const organizationId = await resolveOrganizationId(query.agentId);
    if (!organizationId) {
      return c.json({ error: "agent_not_found" }, 404);
    }

    const config = await buildWebhookConfig(organizationId, query.agentId, query.platform);
    if (!config) {
      return c.json({ error: "webhook_config_not_found" }, 404);
    }

    return c.json(config);
  } catch (err) {
    logger.error("[internal/webhook/config]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
