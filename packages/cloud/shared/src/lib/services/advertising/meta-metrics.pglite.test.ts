/**
 * Meta campaign metrics through the real service and repository boundary.
 * Only the Meta HTTP response and encrypted-secret read are replaced.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error("meta-metrics.pglite.test requires an isolated PGlite DATABASE_URL");
}
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { adAccounts } from "../../../db/schemas/ad-accounts";
import { adCampaigns } from "../../../db/schemas/ad-campaigns";
import { adConversionEvents } from "../../../db/schemas/ad-conversions";
import { adCreatives } from "../../../db/schemas/ad-creatives";
import { appDeploymentStatusEnum, appReviewStatusEnum, apps } from "../../../db/schemas/apps";
import { organizations } from "../../../db/schemas/organizations";
import {
  secretEnvironmentEnum,
  secretProviderEnum,
  secretScopeEnum,
  secrets,
} from "../../../db/schemas/secrets";
import { users } from "../../../db/schemas/users";

const TEST_TIMEOUT = 60_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let advertisingService: typeof import("./index").advertisingService;
let secretsService: ReturnType<typeof import("../secrets").getSecretsService>;
let originalGetDecryptedValue: typeof secretsService.getDecryptedValue;
let originalFetch: typeof globalThis.fetch;
let organizationId: string;
let campaignId: string;
let metaConversions: Array<{ action_type: string; value: string }> = [];

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ advertisingService } = await import("./index"));
  const { getSecretsService } = await import("../secrets");
  secretsService = getSecretsService();

  const { apply } = await pushSchema(
    {
      organizations,
      users,
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      apps,
      secretScopeEnum,
      secretEnvironmentEnum,
      secretProviderEnum,
      secrets,
      adAccounts,
      adCampaigns,
      adCreatives,
      adConversionEvents,
    } as never,
    dbWrite as never,
  );
  await apply();

  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Meta Metrics Org", slug: "meta-metrics-org" })
    .returning();
  organizationId = organization.id;

  const [user] = await dbWrite
    .insert(users)
    .values({ organization_id: organizationId, steward_user_id: "meta-metrics-user" })
    .returning();
  const [secret] = await dbWrite
    .insert(secrets)
    .values({
      organization_id: organizationId,
      name: "meta-access-token",
      encrypted_value: "test",
      encryption_key_id: "test",
      encrypted_dek: "test",
      nonce: "test",
      auth_tag: "test",
      created_by: user.id,
    })
    .returning();
  const [account] = await dbWrite
    .insert(adAccounts)
    .values({
      organization_id: organizationId,
      connected_by_user_id: user.id,
      platform: "meta",
      external_account_id: "act_123",
      account_name: "Meta test account",
      access_token_secret_id: secret.id,
      status: "active",
    })
    .returning();
  const [campaign] = await dbWrite
    .insert(adCampaigns)
    .values({
      organization_id: organizationId,
      ad_account_id: account.id,
      external_campaign_id: "campaign-123",
      name: "Meta test campaign",
      platform: "meta",
      objective: "conversions",
      status: "active",
      budget_type: "daily",
      budget_amount: "25.00",
      total_conversions: 9,
    })
    .returning();
  campaignId = campaign.id;

  originalGetDecryptedValue = secretsService.getDecryptedValue;
  secretsService.getDecryptedValue = async () => "meta-access-token";

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    expect(String(input)).toContain("/campaign-123/insights");
    return new Response(
      JSON.stringify({
        data: [
          {
            spend: "12.34",
            impressions: "100",
            clicks: "5",
            conversions: metaConversions,
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}, TEST_TIMEOUT);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  secretsService.getDecryptedValue = originalGetDecryptedValue;
  await closeDb();
});

test(
  "persists one Meta conversion action as an integer and rejects ambiguous actions",
  async () => {
    metaConversions = [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "2.5" }];

    const metrics = await advertisingService.getCampaignMetrics(campaignId, organizationId);
    expect(metrics.providerConversions).toBe(2);
    expect(metrics.conversions).toBe(2);

    const [stored] = await dbWrite
      .select({ conversions: adCampaigns.total_conversions })
      .from(adCampaigns)
      .where(eq(adCampaigns.id, campaignId));
    expect(stored.conversions).toBe(2);

    metaConversions = [
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
      { action_type: "lead", value: "1" },
    ];

    await expect(advertisingService.getCampaignMetrics(campaignId, organizationId)).rejects.toThrow(
      "Meta Ads returned multiple conversion action types",
    );

    const [unchanged] = await dbWrite
      .select({ conversions: adCampaigns.total_conversions })
      .from(adCampaigns)
      .where(eq(adCampaigns.id, campaignId));
    expect(unchanged.conversions).toBe(2);
  },
  TEST_TIMEOUT,
);
