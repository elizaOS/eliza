/**
 * Public SSP endpoints (#10687) — REAL route handlers + REAL service + PGlite.
 *
 * The serve/click endpoints are public and move money, so this drives the
 * abuse boundary end to end through the mounted Hono routes:
 *   - serve requires a valid signed ad-tag token (missing → 401, invalid /
 *     wrong-slot / expired → 403); a bare slot id cannot generate impressions.
 *   - a valid token serves, debits the advertiser, and pays the publisher.
 *   - click only lands against a served impression on the SAME slot, once.
 *   - the click endpoint's STRICT IP-keyed rate limit returns 429 past the cap.
 *
 * Self-skips LOUDLY if PGlite/pushSchema is unavailable.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.ELIZA_AD_TAG_SECRET = "route-test-ad-tag-secret";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { closeDatabaseConnectionsForTests, dbWrite } from "@/db/client";
// Via cloud-shared so `drizzle-kit` (its devDependency) resolves at runtime.
import { pushSchema } from "@/db/push-schema-for-tests";
import { adAccounts } from "@/db/schemas/ad-accounts";
import { adCampaigns } from "@/db/schemas/ad-campaigns";
import { adCreatives } from "@/db/schemas/ad-creatives";
import { adSlotEvents, adSlots } from "@/db/schemas/ad-slots";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "@/db/schemas/apps";
import { organizations } from "@/db/schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
  redeemedEarningsTracking,
} from "@/db/schemas/redeemable-earnings";
import {
  secretEnvironmentEnum,
  secretProviderEnum,
  secretScopeEnum,
  secrets,
} from "@/db/schemas/secrets";
import { users } from "@/db/schemas/users";
import { mintAdTagToken } from "@/lib/services/ad-tag-token";
import type { AppEnv } from "@/types/cloud-worker-env";
import clickRoute from "../v1/marketing/inventory/click/route";
import serveRoute from "../v1/marketing/inventory/serve/route";

const ENV = {
  NODE_ENV: "test",
  MOCK_REDIS: "1",
} as unknown as AppEnv["Bindings"];

const PGLITE_TIMEOUT = 180_000;
let pgliteReady = true;

const api = new Hono<AppEnv>();
api.route("/api/v1/marketing/inventory/serve", serveRoute);
api.route("/api/v1/marketing/inventory/click", clickRoute);

let seq = 0;
function uniq(p: string): string {
  seq += 1;
  return `${p}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seedWorld() {
  const [pubOrg] = await dbWrite
    .insert(organizations)
    .values({ name: "Pub", slug: uniq("pub") })
    .returning();
  const [pubUser] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("pub-u"), organization_id: pubOrg.id })
    .returning();
  const [app] = await dbWrite
    .insert(apps)
    .values({
      name: "Pub App",
      slug: uniq("app"),
      organization_id: pubOrg.id,
      created_by_user_id: pubUser.id,
      app_url: "https://placeholder.invalid",
    })
    .returning();
  const [slot] = await dbWrite
    .insert(adSlots)
    .values({
      app_id: app.id,
      organization_id: pubOrg.id,
      name: "Header",
      format: "banner",
      floor_cpm: "20.0000", // $0.02/impression
    })
    .returning();

  const [advOrg] = await dbWrite
    .insert(organizations)
    .values({ name: "Adv", slug: uniq("adv") })
    .returning();
  const [advUser] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("adv-u"), organization_id: advOrg.id })
    .returning();
  const [account] = await dbWrite
    .insert(adAccounts)
    .values({
      organization_id: advOrg.id,
      connected_by_user_id: advUser.id,
      platform: "meta",
      external_account_id: uniq("acct"),
      account_name: "Adv Account",
      status: "active",
    })
    .returning();
  const [campaign] = await dbWrite
    .insert(adCampaigns)
    .values({
      organization_id: advOrg.id,
      ad_account_id: account.id,
      name: "Campaign",
      platform: "meta",
      objective: "awareness",
      status: "active",
      budget_type: "daily",
      credits_allocated: "100.00",
      credits_spent: "0.00",
    })
    .returning();
  await dbWrite.insert(adCreatives).values({
    campaign_id: campaign.id,
    name: "Creative",
    type: "image",
    status: "active",
    headline: "Buy widgets",
    destination_url: "https://advertiser.example.com",
  });

  return {
    slot,
    appId: app.id,
    campaignId: campaign.id,
    pubUserId: pubUser.id,
  };
}

function serveUrl(slotId: string, token?: string): string {
  const qs = new URLSearchParams({ slot: slotId });
  if (token) qs.set("token", token);
  return `/api/v1/marketing/inventory/serve?${qs.toString()}`;
}

async function get(path: string, ip: string): Promise<Response> {
  return api.request(path, { headers: { "cf-connecting-ip": ip } }, ENV);
}

async function postClick(body: unknown, ip: string): Promise<Response> {
  return api.request(
    "/api/v1/marketing/inventory/click",
    {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      apps,
      secrets,
      secretScopeEnum,
      secretEnvironmentEnum,
      secretProviderEnum,
      adAccounts,
      adCampaigns,
      adCreatives,
      adSlots,
      adSlotEvents,
      redeemableEarnings,
      redeemableEarningsLedger,
      redeemedEarningsTracking,
      appDeploymentStatusEnum,
      appReviewStatusEnum,
      userDatabaseStatusEnum,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[ad-inventory-public-routes.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("public SSP routes (#10687) — signed ad-tag boundary", () => {
  beforeEach(async () => {
    // Each test seeds its own world; pause every earlier campaign so the
    // eligible-ad pick (highest remaining budget, ties arbitrary) is
    // deterministic within a test.
    if (pgliteReady)
      await dbWrite.update(adCampaigns).set({ status: "paused" });
  });

  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("serve without a token is rejected (401) and moves no money", async () => {
    if (!pgliteReady) return;
    const world = await seedWorld();
    const res = await get(serveUrl(world.slot.id), "10.1.0.1");
    expect(res.status).toBe(401);
    const campaign = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, world.campaignId),
    });
    expect(Number(campaign?.credits_spent)).toBe(0);
    expect(campaign?.total_impressions).toBe(0);
  });

  test("serve with a garbage token is rejected (403)", async () => {
    if (!pgliteReady) return;
    const world = await seedWorld();
    const res = await get(
      serveUrl(world.slot.id, "v1.9999999999.deadbeef"),
      "10.1.0.2",
    );
    expect(res.status).toBe(403);
  });

  test("a token minted for a DIFFERENT slot does not serve this one", async () => {
    if (!pgliteReady) return;
    const world = await seedWorld();
    const other = await seedWorld();
    const otherToken = await mintAdTagToken({
      slotId: other.slot.id,
      appId: other.appId,
    });
    const res = await get(serveUrl(world.slot.id, otherToken!), "10.1.0.3");
    expect(res.status).toBe(403);
  });

  test("an expired token is rejected (403)", async () => {
    if (!pgliteReady) return;
    const world = await seedWorld();
    const expired = await mintAdTagToken({
      slotId: world.slot.id,
      appId: world.appId,
      ttlSeconds: -10,
    });
    const res = await get(serveUrl(world.slot.id, expired!), "10.1.0.4");
    expect(res.status).toBe(403);
  });

  test("a valid token serves the ad, debits the advertiser, pays the publisher", async () => {
    if (!pgliteReady) return;
    const world = await seedWorld();
    const token = await mintAdTagToken({
      slotId: world.slot.id,
      appId: world.appId,
    });
    const res = await get(serveUrl(world.slot.id, token!), "10.1.0.5");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      ad: { impressionId: string; headline: string };
    };
    expect(body.success).toBe(true);
    expect(body.ad.headline).toBe("Buy widgets");
    expect(body.ad.impressionId).toBeTruthy();

    const campaign = await dbWrite.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, world.campaignId),
    });
    expect(Number(campaign?.credits_spent)).toBeCloseTo(0.02, 6);
    const earnings = await dbWrite.query.redeemableEarnings.findFirst({
      where: eq(redeemableEarnings.user_id, world.pubUserId),
    });
    expect(Number(earnings?.available_balance)).toBeCloseTo(0.014, 6);

    // Click path: wrong slot → not recorded; right slot → once, then dedup.
    const click = (slot: string) =>
      postClick({ slot, impression_id: body.ad.impressionId }, "10.1.0.5");
    const wrongSlot = await seedWorld();
    expect(
      ((await (await click(wrongSlot.slot.id)).json()) as { recorded: boolean })
        .recorded,
    ).toBe(false);
    expect(
      ((await (await click(world.slot.id)).json()) as { recorded: boolean })
        .recorded,
    ).toBe(true);
    expect(
      ((await (await click(world.slot.id)).json()) as { recorded: boolean })
        .recorded,
    ).toBe(false);
  });

  test("unknown slot is a 404 even with a token-shaped value", async () => {
    if (!pgliteReady) return;
    const res = await get(
      serveUrl("99999999-9999-4999-8999-999999999999", "v1.9999999999.00"),
      "10.1.0.6",
    );
    expect(res.status).toBe(404);
  });

  test("click endpoint enforces the STRICT IP-keyed rate limit (429 past the cap)", async () => {
    if (!pgliteReady) return;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await postClick(
        { slot: "88888888-8888-4888-8888-888888888888", impression_id: "x" },
        "10.9.9.9",
      );
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s !== 429).length).toBeLessThanOrEqual(10);
  });
});
