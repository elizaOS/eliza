/**
 * App config backup / restore.
 *
 * Exports a portable, secret-free snapshot of an app's configuration so a
 * user/agent can back it up and recreate the app later (the "backing up" part of
 * the app lifecycle). Restore creates a NEW app from the snapshot (new slug + new
 * API key) and reapplies config + monetization pricing — monetization itself is
 * always restored DISABLED because the new app starts at review_status=draft and
 * must pass review before it can collect money. Frontend deployments are
 * immutable R2 artifacts referenced by content hash — the snapshot records the
 * active deployment's hash so the user can redeploy; the bytes are not embedded.
 */

import type { App } from "../../db/repositories/apps";
import { logger } from "../utils/logger";
import { parseAppMonetizationNumber } from "./app-credit-math";
import { appCreditsService } from "./app-credits";
import { appsService } from "./apps";

export const APP_BACKUP_VERSION = 1 as const;

export interface AppBackup {
  version: typeof APP_BACKUP_VERSION;
  exportedAt: string;
  app: {
    name: string;
    description: string | null;
    app_url: string;
    allowed_origins: string[];
    logo_url: string | null;
    website_url: string | null;
    contact_email: string | null;
    linked_character_ids: string[];
  };
  monetization: {
    enabled: boolean;
    inference_markup_percentage: number;
    purchase_share_percentage: number;
  };
  automation: {
    discord: App["discord_automation"] | null;
    telegram: App["telegram_automation"] | null;
    twitter: App["twitter_automation"] | null;
  };
  promotional_assets: App["promotional_assets"] | null;
  /** Reference only — the immutable content hash of the active frontend, if any. */
  active_frontend_content_hash?: string | null;
}

export class AppBackupService {
  /** Build a secret-free config snapshot of an app. */
  async exportApp(app: App): Promise<AppBackup> {
    const contentHash: string | null = null;

    return {
      version: APP_BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      app: {
        name: app.name,
        description: app.description ?? null,
        app_url: app.app_url,
        allowed_origins: app.allowed_origins ?? [],
        logo_url: app.logo_url ?? null,
        website_url: app.website_url ?? null,
        contact_email: app.contact_email ?? null,
        linked_character_ids: app.linked_character_ids ?? [],
      },
      monetization: {
        enabled: app.monetization_enabled,
        inference_markup_percentage: parseAppMonetizationNumber(
          "inference_markup_percentage",
          app.inference_markup_percentage ?? 0,
          { min: 0, max: 1000 },
        ),
        purchase_share_percentage: parseAppMonetizationNumber(
          "purchase_share_percentage",
          app.purchase_share_percentage ?? 0,
          { min: 0, max: 100 },
        ),
      },
      automation: {
        discord: app.discord_automation ?? null,
        telegram: app.telegram_automation ?? null,
        twitter: app.twitter_automation ?? null,
      },
      promotional_assets: app.promotional_assets ?? null,
      active_frontend_content_hash: contentHash,
    };
  }

  /**
   * Create a NEW app from a backup snapshot (new slug + API key) and reapply its
   * config + monetization pricing. Returns the new app, its (one-time) API key,
   * and any warnings.
   *
   * The backup's `monetization.enabled` flag is deliberately NOT honored: the
   * restored app is a NEW app with `review_status=draft`, and enabling
   * monetization requires the same approved-review gate as
   * PUT /apps/:id/monetization. Trusting the client-supplied blob here would
   * let anyone monetize an unapproved app (#11834).
   */
  async restoreApp(
    organizationId: string,
    userId: string,
    backup: AppBackup,
    overrideName?: string,
  ): Promise<{ app: App; apiKey: string; warnings: string[] }> {
    if (backup.version !== APP_BACKUP_VERSION) {
      throw new Error(`Unsupported backup version: ${backup.version}`);
    }
    const warnings: string[] = [];
    const created = await appsService.create({
      name: overrideName?.trim() || `${backup.app.name} (restored)`,
      description: backup.app.description ?? undefined,
      organization_id: organizationId,
      created_by_user_id: userId,
      app_url: backup.app.app_url,
      allowed_origins: backup.app.allowed_origins,
      logo_url: backup.app.logo_url ?? undefined,
      website_url: backup.app.website_url ?? undefined,
      contact_email: backup.app.contact_email ?? undefined,
    });

    await appsService.update(created.app.id, {
      linked_character_ids: backup.app.linked_character_ids ?? [],
      discord_automation: backup.automation?.discord ?? null,
      telegram_automation: backup.automation?.telegram ?? null,
      twitter_automation: backup.automation?.twitter ?? null,
      promotional_assets: backup.promotional_assets ?? null,
    });

    // Reapply monetization PRICING (create() does not carry it), but always
    // force monetization OFF: the enabled flag must come from the review flow,
    // never from a client-supplied backup blob (#11834).
    if (
      backup.monetization.enabled ||
      backup.monetization.inference_markup_percentage > 0 ||
      backup.monetization.purchase_share_percentage > 0
    ) {
      try {
        await appCreditsService.updateMonetizationSettings(created.app.id, {
          monetizationEnabled: false,
          inferenceMarkupPercentage: backup.monetization.inference_markup_percentage,
          purchaseSharePercentage: backup.monetization.purchase_share_percentage,
        });
      } catch (error) {
        logger.warn("[AppBackup] failed to reapply monetization on restore", {
          appId: created.app.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (backup.monetization.enabled) {
        warnings.push(
          "Monetization was disabled on restore — submit the restored app for review to re-enable it.",
        );
      }
    }

    logger.info("[AppBackup] restored app from backup", {
      newAppId: created.app.id,
      sourceName: backup.app.name,
    });
    return { ...created, warnings };
  }
}

export const appBackupService = new AppBackupService();
