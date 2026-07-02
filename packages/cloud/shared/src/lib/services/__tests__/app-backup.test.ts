/**
 * App config backup/restore (#10204 "backing up") — real Drizzle schema, PGlite.
 *
 * Exports a secret-free config snapshot of an app and restores it as a NEW app
 * (new slug + new API key) with monetization reapplied. Fails loudly (via the
 * `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a
 * silent skip.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports. resolveDatabaseUrl
// prefers TEST_DATABASE_URL, so BOTH are pinned — otherwise the suite is steered
// to a Postgres that isn't up under the unit lane and self-skips to a vacuous
// green (a money-path proof shipping unproven).
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { apiKeys } from "../../../db/schemas/api-keys";
import { appConfig } from "../../../db/schemas/app-config";
import { appEarnings } from "../../../db/schemas/app-earnings";
import {
  appDeploymentStatusEnum,
  appReviewStatusEnum,
  apps,
  userDatabaseStatusEnum,
} from "../../../db/schemas/apps";
import { organizations } from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let appBackupService: typeof import("../app-backup").appBackupService;
let appsService: typeof import("../apps").appsService;

let seq = 0;
const uniq = (p: string) => `${p}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

async function seed(): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "O", slug: uniq("o") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("u"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

beforeAll(async () => {
  try {
    ({ appBackupService } = await import("../app-backup"));
    ({ appsService } = await import("../apps"));
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        apps,
        apiKeys,
        appConfig,
        appEarnings,
        appDeploymentStatusEnum,
        appReviewStatusEnum,
        userDatabaseStatusEnum,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error("[app-backup.test] PGlite/pushSchema unavailable — skipping.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("App config backup/restore", () => {
  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("export produces a secret-free snapshot; restore creates a new configured app", async () => {
    if (!pgliteReady) return;
    const { orgId, userId } = await seed();

    // Create + monetize a source app.
    const { app: source } = await appsService.create({
      name: "My Monetized App",
      description: "sells widgets",
      organization_id: orgId,
      created_by_user_id: userId,
      app_url: "https://myapp.example.com",
      allowed_origins: ["https://myapp.example.com"],
      contact_email: "me@example.com",
    });
    const { appCreditsService } = await import("../app-credits");
    await appCreditsService.updateMonetizationSettings(source.id, {
      monetizationEnabled: true,
      inferenceMarkupPercentage: 25,
      purchaseSharePercentage: 40,
    });
    await appsService.update(source.id, {
      linked_character_ids: ["11111111-1111-4111-8111-111111111111"],
      discord_automation: {
        enabled: true,
        guildId: "guild-1",
        channelId: "channel-1",
        autoAnnounce: true,
        announceIntervalMin: 60,
        announceIntervalMax: 120,
      },
      telegram_automation: {
        enabled: true,
        groupId: "chat-1",
        autoReply: true,
        autoAnnounce: true,
        announceIntervalMin: 60,
        announceIntervalMax: 120,
      },
      twitter_automation: {
        enabled: false,
        autoPost: false,
        autoReply: false,
        autoEngage: false,
        discovery: false,
        postIntervalMin: 90,
        postIntervalMax: 150,
      },
      promotional_assets: [
        {
          type: "social_card",
          url: "https://cdn.example.com/card.png",
          size: { width: 1200, height: 630 },
          generatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    const fresh = await appsService.getById(source.id);
    const backup = await appBackupService.exportApp(fresh!);

    // Snapshot has config, not secrets.
    expect(backup.version).toBe(1);
    expect(backup.app.name).toBe("My Monetized App");
    expect(backup.app.allowed_origins).toEqual(["https://myapp.example.com"]);
    expect(backup.monetization).toMatchObject({
      enabled: true,
      inference_markup_percentage: 25,
      purchase_share_percentage: 40,
    });
    expect(backup.app.linked_character_ids).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(backup.automation.discord).toMatchObject({ guildId: "guild-1", channelId: "channel-1" });
    expect(backup.automation.telegram).toMatchObject({ groupId: "chat-1" });
    expect(backup.promotional_assets).toEqual([
      {
        type: "social_card",
        url: "https://cdn.example.com/card.png",
        size: { width: 1200, height: 630 },
        generatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
    // No secret fields leak into the snapshot.
    expect(JSON.stringify(backup)).not.toContain("api_key");
    expect(JSON.stringify(backup)).not.toContain(source.id);

    // Restore → a NEW app with the config + monetization reapplied.
    const { app: restored, apiKey } = await appBackupService.restoreApp(orgId, userId, backup);
    expect(restored.id).not.toBe(source.id);
    expect(restored.slug).not.toBe(source.slug);
    expect(apiKey).toBeTruthy();
    expect(restored.name).toContain("My Monetized App");

    const restoredFresh = await appsService.getById(restored.id);
    expect(restoredFresh?.monetization_enabled).toBe(true);
    expect(Number(restoredFresh?.inference_markup_percentage)).toBe(25);
    expect(Number(restoredFresh?.purchase_share_percentage)).toBe(40);
    expect(restoredFresh?.allowed_origins).toEqual(["https://myapp.example.com"]);
    expect(restoredFresh?.linked_character_ids).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(restoredFresh?.discord_automation).toMatchObject({
      guildId: "guild-1",
      channelId: "channel-1",
    });
    expect(restoredFresh?.telegram_automation).toMatchObject({ groupId: "chat-1" });
    expect(restoredFresh?.twitter_automation).toMatchObject({ enabled: false });
    expect(restoredFresh?.promotional_assets).toEqual([
      {
        type: "social_card",
        url: "https://cdn.example.com/card.png",
        size: { width: 1200, height: 630 },
        generatedAt: "2026-07-01T00:00:00.000Z",
      },
    ]);
  });

  test("restore rejects an unsupported backup version", async () => {
    if (!pgliteReady) return;
    const { orgId, userId } = await seed();
    await expect(
      appBackupService.restoreApp(orgId, userId, { version: 999 } as never),
    ).rejects.toThrow(/version/i);
  });
});
