/**
 * Webhook Provider CRUD Integration Tests
 *
 * Exercises the persisted webhook integration state used by the Cloud API:
 * Twilio, Blooio, WhatsApp, and Telegram credentials can be created,
 * read, updated by reconnecting, and deleted.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { blooioAutomationService } from "@/lib/services/blooio-automation";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { twilioAutomationService } from "@/lib/services/twilio-automation";
import { whatsappAutomationService } from "@/lib/services/whatsapp-automation";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "../infrastructure/test-data-factory";

const TEST_DB_URL = process.env.DATABASE_URL || "";

const PROVIDER_SECRET_NAMES = {
  twilio: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
  blooio: [BLOOIO_API_KEY, BLOOIO_WEBHOOK_SECRET, BLOOIO_FROM_NUMBER],
  whatsapp: [
    WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_BUSINESS_PHONE,
  ],
  telegram: [TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_BOT_ID, TELEGRAM_WEBHOOK_SECRET],
} as const;

type ProviderName = keyof typeof PROVIDER_SECRET_NAMES;

describe.skipIf(!TEST_DB_URL)("Webhook provider CRUD integration", () => {
  let testData: TestDataSet;
  let client: Client;

  async function deleteProviderSecrets(provider: ProviderName): Promise<void> {
    await client.query(
      `DELETE FROM secrets WHERE organization_id = $1 AND name = ANY($2::text[])`,
      [testData.organization.id, [...PROVIDER_SECRET_NAMES[provider]]],
    );
  }

  async function providerSecretNames(provider: ProviderName): Promise<string[]> {
    const result = await client.query<{ name: string }>(
      `SELECT name FROM secrets WHERE organization_id = $1 AND name = ANY($2::text[]) ORDER BY name`,
      [testData.organization.id, [...PROVIDER_SECRET_NAMES[provider]]],
    );
    return result.rows.map((row) => row.name);
  }

  beforeAll(async () => {
    testData = await createTestDataSet(TEST_DB_URL, {
      organizationName: "Webhook CRUD Integration Org",
      creditBalance: 1000,
    });

    client = new Client({ connectionString: TEST_DB_URL });
    await client.connect();

    for (const provider of Object.keys(PROVIDER_SECRET_NAMES) as ProviderName[]) {
      await deleteProviderSecrets(provider);
    }
  });

  afterAll(async () => {
    if (client && testData) {
      for (const provider of Object.keys(PROVIDER_SECRET_NAMES) as ProviderName[]) {
        await deleteProviderSecrets(provider);
      }
      await client.end();
      await cleanupTestData(TEST_DB_URL, testData.organization.id);
    }
  });

  it("creates, reads, updates, and deletes Twilio webhook credentials", async () => {
    await twilioAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
      accountSid: "ACtwiliofirst",
      authToken: "twilio-token-one",
      phoneNumber: "+15550000001",
    });

    expect(await twilioAutomationService.getAccountSid(testData.organization.id)).toBe(
      "ACtwiliofirst",
    );
    expect(await twilioAutomationService.getAuthToken(testData.organization.id)).toBe(
      "twilio-token-one",
    );
    expect(await twilioAutomationService.getPhoneNumber(testData.organization.id)).toBe(
      "+15550000001",
    );
    expect(twilioAutomationService.getWebhookUrl(testData.organization.id)).toContain(
      `/api/webhooks/twilio/${testData.organization.id}`,
    );

    await twilioAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
      accountSid: "ACtwiliosecond",
      authToken: "twilio-token-two",
      phoneNumber: "+15550000002",
    });

    expect(await twilioAutomationService.getAccountSid(testData.organization.id)).toBe(
      "ACtwiliosecond",
    );
    expect(await twilioAutomationService.getAuthToken(testData.organization.id)).toBe(
      "twilio-token-two",
    );
    expect(await twilioAutomationService.getPhoneNumber(testData.organization.id)).toBe(
      "+15550000002",
    );
    expect(await providerSecretNames("twilio")).toEqual([...PROVIDER_SECRET_NAMES.twilio].sort());

    await twilioAutomationService.removeCredentials(testData.organization.id, testData.user.id);
    expect(await providerSecretNames("twilio")).toEqual([]);
  });

  it("creates, reads, updates, and deletes Blooio webhook credentials", async () => {
    await blooioAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
      apiKey: "blooio-key-one",
      webhookSecret: "blooio-secret-one",
      fromNumber: "+15550000003",
    });

    expect(await blooioAutomationService.getApiKey(testData.organization.id)).toBe(
      "blooio-key-one",
    );
    expect(await blooioAutomationService.getWebhookSecret(testData.organization.id)).toBe(
      "blooio-secret-one",
    );
    expect(await blooioAutomationService.getFromNumber(testData.organization.id)).toBe(
      "+15550000003",
    );
    expect(blooioAutomationService.getWebhookUrl(testData.organization.id)).toContain(
      `/api/webhooks/blooio/${testData.organization.id}`,
    );

    await blooioAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
      apiKey: "blooio-key-two",
      webhookSecret: "blooio-secret-two",
      fromNumber: "+15550000004",
    });

    expect(await blooioAutomationService.getApiKey(testData.organization.id)).toBe(
      "blooio-key-two",
    );
    expect(await blooioAutomationService.getWebhookSecret(testData.organization.id)).toBe(
      "blooio-secret-two",
    );
    expect(await blooioAutomationService.getFromNumber(testData.organization.id)).toBe(
      "+15550000004",
    );
    expect(await providerSecretNames("blooio")).toEqual([...PROVIDER_SECRET_NAMES.blooio].sort());

    await blooioAutomationService.removeCredentials(testData.organization.id, testData.user.id);
    expect(await providerSecretNames("blooio")).toEqual([]);
  });

  it("creates, reads, updates, and deletes WhatsApp webhook credentials", async () => {
    await whatsappAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
      accessToken: "whatsapp-token-one",
      phoneNumberId: "phone-number-id-one",
      appSecret: "whatsapp-app-secret-one",
      verifyToken: "verify-token-one",
      businessPhone: "+15550000005",
    });

    expect(await whatsappAutomationService.getAccessToken(testData.organization.id)).toBe(
      "whatsapp-token-one",
    );
    expect(await whatsappAutomationService.getPhoneNumberId(testData.organization.id)).toBe(
      "phone-number-id-one",
    );
    expect(await whatsappAutomationService.getAppSecret(testData.organization.id)).toBe(
      "whatsapp-app-secret-one",
    );
    expect(
      await whatsappAutomationService.verifyWebhookSubscription(
        testData.organization.id,
        "subscribe",
        "verify-token-one",
        "challenge-one",
      ),
    ).toBe("challenge-one");
    expect(whatsappAutomationService.getWebhookUrl(testData.organization.id)).toContain(
      `/api/webhooks/whatsapp/${testData.organization.id}`,
    );

    await whatsappAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
      accessToken: "whatsapp-token-two",
      phoneNumberId: "phone-number-id-two",
      appSecret: "whatsapp-app-secret-two",
      verifyToken: "verify-token-two",
      businessPhone: "+15550000006",
    });

    expect(await whatsappAutomationService.getAccessToken(testData.organization.id)).toBe(
      "whatsapp-token-two",
    );
    expect(await whatsappAutomationService.getPhoneNumberId(testData.organization.id)).toBe(
      "phone-number-id-two",
    );
    expect(
      await whatsappAutomationService.verifyWebhookSubscription(
        testData.organization.id,
        "subscribe",
        "verify-token-one",
        "challenge-old",
      ),
    ).toBeNull();
    expect(
      await whatsappAutomationService.verifyWebhookSubscription(
        testData.organization.id,
        "subscribe",
        "verify-token-two",
        "challenge-two",
      ),
    ).toBe("challenge-two");
    expect(await providerSecretNames("whatsapp")).toEqual(
      [...PROVIDER_SECRET_NAMES.whatsapp].sort(),
    );

    await whatsappAutomationService.removeCredentials(testData.organization.id, testData.user.id);
    expect(await providerSecretNames("whatsapp")).toEqual([]);
  });

  it("creates, reads, updates, and deletes Telegram webhook credentials", async () => {
    await telegramAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
      botToken: "telegram-token-one",
      botUsername: "first_test_bot",
      botId: 1001,
      webhookSecret: "telegram-secret-one",
    });

    expect(await telegramAutomationService.getBotToken(testData.organization.id)).toBe(
      "telegram-token-one",
    );
    expect(await telegramAutomationService.getWebhookSecret(testData.organization.id)).toBe(
      "telegram-secret-one",
    );
    expect(telegramAutomationService.getWebhookUrl(testData.organization.id)).toContain(
      `/api/v1/telegram/webhook/${testData.organization.id}`,
    );

    await telegramAutomationService.storeCredentials(testData.organization.id, testData.user.id, {
      botToken: "telegram-token-two",
      botUsername: "second_test_bot",
      botId: 1002,
      webhookSecret: "telegram-secret-two",
    });

    expect(await telegramAutomationService.getBotToken(testData.organization.id)).toBe(
      "telegram-token-two",
    );
    expect(await telegramAutomationService.getWebhookSecret(testData.organization.id)).toBe(
      "telegram-secret-two",
    );
    expect(await providerSecretNames("telegram")).toEqual(
      [...PROVIDER_SECRET_NAMES.telegram].sort(),
    );

    await telegramAutomationService.removeCredentials(testData.organization.id, testData.user.id);
    expect(await providerSecretNames("telegram")).toEqual([]);
  });
});
