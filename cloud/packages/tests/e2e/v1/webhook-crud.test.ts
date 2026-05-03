import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  BLOOIO_API_KEY,
  BLOOIO_FROM_NUMBER,
  BLOOIO_WEBHOOK_SECRET,
  TELEGRAM_BOT_ID,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME,
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
import * as api from "../helpers/api-client";

const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const TEST_ORGANIZATION_ID = process.env.TEST_ORGANIZATION_ID || "";

const WEBHOOK_SECRET_NAMES = [
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  BLOOIO_API_KEY,
  BLOOIO_WEBHOOK_SECRET,
  BLOOIO_FROM_NUMBER,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_APP_SECRET,
  WHATSAPP_VERIFY_TOKEN,
  WHATSAPP_BUSINESS_PHONE,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME,
  TELEGRAM_BOT_ID,
  TELEGRAM_WEBHOOK_SECRET,
];

type StatusBody = {
  connected?: boolean;
  configured?: boolean;
  webhookConfigured?: boolean;
  webhookUrl?: string;
  verifyToken?: string;
  hasWebhookSecret?: boolean;
  webhookInfo?: unknown;
};

const PROVIDERS = [
  {
    name: "twilio",
    statusPath: "/api/v1/twilio/status",
    connectPath: "/api/v1/twilio/connect",
    disconnectPath: "/api/v1/twilio/disconnect",
    webhookPath: `/api/webhooks/twilio/${TEST_ORGANIZATION_ID}`,
  },
  {
    name: "blooio",
    statusPath: "/api/v1/blooio/status",
    connectPath: "/api/v1/blooio/connect",
    disconnectPath: "/api/v1/blooio/disconnect",
    webhookPath: `/api/webhooks/blooio/${TEST_ORGANIZATION_ID}`,
  },
  {
    name: "whatsapp",
    statusPath: "/api/v1/whatsapp/status",
    connectPath: "/api/v1/whatsapp/connect",
    disconnectPath: "/api/v1/whatsapp/disconnect",
    webhookPath: `/api/webhooks/whatsapp/${TEST_ORGANIZATION_ID}`,
  },
  {
    name: "telegram",
    statusPath: "/api/v1/telegram/status",
    connectPath: "/api/v1/telegram/connect",
    disconnectPath: "/api/v1/telegram/disconnect",
    webhookPath: `/api/v1/telegram/webhook/${TEST_ORGANIZATION_ID}`,
  },
] as const;

describe("Cloud webhook CRUD API e2e", () => {
  let client: Client;

  async function resetWebhookSecrets(): Promise<void> {
    await client.query(
      `DELETE FROM secrets WHERE organization_id = $1 AND name = ANY($2::text[])`,
      [TEST_ORGANIZATION_ID, WEBHOOK_SECRET_NAMES],
    );
  }

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DB_URL });
    await client.connect();
    await resetWebhookSecrets();
  });

  afterAll(async () => {
    if (client) {
      await resetWebhookSecrets();
      await client.end();
    }
  });

  for (const provider of PROVIDERS) {
    describe(`${provider.name} webhook routes`, () => {
      test("read returns disconnected status with webhook metadata", async () => {
        await resetWebhookSecrets();
        await api.del(provider.disconnectPath, { headers: api.authHeaders() });

        const response = await api.get(provider.statusPath, { headers: api.authHeaders() });
        expect(response.status).toBe(200);

        const body = (await response.json()) as StatusBody;
        expect(typeof body.connected).toBe("boolean");
        expect(body.webhookUrl).toContain(provider.webhookPath);

        if (provider.name === "twilio") {
          expect(body.connected).toBe(false);
          expect(body.webhookConfigured).toBe(false);
        }
        if (provider.name === "whatsapp") {
          expect(body.verifyToken).toBeUndefined();
        }
        if (provider.name === "telegram") {
          expect(body.connected).toBe(false);
          expect(body.configured).toBe(false);
          expect(body.webhookInfo).toBeNull();
        }
      });

      test("create validates empty webhook configuration payload", async () => {
        const response = await api.post(provider.connectPath, {}, { headers: api.authHeaders() });
        expect(response.status).toBe(400);

        const body = (await response.json()) as { error?: string; details?: unknown };
        expect(body.error || body.details).toBeTruthy();
      });

      test("delete is idempotent for disconnected webhook configuration", async () => {
        await resetWebhookSecrets();

        const response = await api.del(provider.disconnectPath, { headers: api.authHeaders() });
        expect(response.status).toBe(200);

        const body = (await response.json()) as { success?: boolean };
        expect(body.success).toBe(true);
      });
    });
  }
});
