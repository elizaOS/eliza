/**
 * Database-backed mobile App Auth client registrations and Digital Asset Links.
 */

import { ElizaError } from "@elizaos/core";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import {
  type AndroidAssetLinkStatement,
  type AndroidAssetLinksRelation,
  parseAndroidAssetLinksConfig,
} from "../../lib/auth/android-asset-links";
import { dbWrite } from "../client";
import { apps } from "../schemas/apps";
import { type MobileAppAuthClient, mobileAppAuthClients } from "../schemas/mobile-app-auth-clients";

export interface PublicAppInfo {
  id: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  website_url: string | null;
  app_url: string;
  allowed_origins: string[];
  is_active: boolean;
  is_approved: boolean;
}

export interface RegisteredMobileClientWithApp {
  client: MobileAppAuthClient;
  app: PublicAppInfo;
}

export const mobileAppAuthClientsRepository = {
  /**
   * Find an active, enabled mobile client registration and its approved app.
   * Uses dbWrite (primary) to guarantee strong consistency for authorization contracts.
   */
  async findRegisteredMobileClient(
    clientId: string,
  ): Promise<RegisteredMobileClientWithApp | null> {
    const rows = await dbWrite
      .select({
        client: mobileAppAuthClients,
        app: {
          id: apps.id,
          name: apps.name,
          description: apps.description,
          logo_url: apps.logo_url,
          website_url: apps.website_url,
          app_url: apps.app_url,
          allowed_origins: apps.allowed_origins,
          is_active: apps.is_active,
          is_approved: apps.is_approved,
        },
      })
      .from(mobileAppAuthClients)
      .innerJoin(apps, eq(apps.id, mobileAppAuthClients.app_id))
      .where(eq(mobileAppAuthClients.client_id, clientId))
      .limit(1);

    if (rows.length === 0) return null;
    return rows[0]!;
  },

  /**
   * List Digital Asset Links statements for all active, enabled Android clients.
   * Merges fingerprints across multiple client registrations for the same package.
   */
  async listActiveAndroidAssetLinks(
    env: import("../../lib/services/mobile-app-auth").MobileAppAuthRuntimeEnv,
  ): Promise<AndroidAssetLinkStatement[]> {
    const rows = await dbWrite
      .select({
        client: mobileAppAuthClients,
        app: {
          id: apps.id,
          name: apps.name,
          description: apps.description,
          logo_url: apps.logo_url,
          website_url: apps.website_url,
          app_url: apps.app_url,
          allowed_origins: apps.allowed_origins,
          is_active: apps.is_active,
          is_approved: apps.is_approved,
        },
      })
      .from(mobileAppAuthClients)
      .innerJoin(apps, eq(apps.id, mobileAppAuthClients.app_id))
      .where(
        and(
          eq(mobileAppAuthClients.enabled, true),
          isNotNull(mobileAppAuthClients.android_package_name),
          eq(apps.is_active, true),
          eq(apps.is_approved, true),
        ),
      );
    const { admitMobileAppAuthRegistration } = await import("../../lib/services/mobile-app-auth");
    const packageFingerprints = new Map<string, Set<string>>();
    const packageRelations = new Map<string, Set<AndroidAssetLinksRelation>>();

    for (const row of rows) {
      await admitMobileAppAuthRegistration(env, row);
      const packageName = row.client.android_package_name;
      const fingerprints = row.client.android_cert_fingerprints;
      if (!packageName || !Array.isArray(fingerprints) || fingerprints.length === 0) continue;
      const parsed = parseAndroidAssetLinksConfig(
        JSON.stringify([
          {
            package_name: packageName,
            sha256_cert_fingerprints: fingerprints,
            ...(row.client.android_relations ? { relations: row.client.android_relations } : {}),
          },
        ]),
      );
      if (!parsed.ok)
        throw new ElizaError("Invalid native Android association", {
          code: "MOBILE_APP_AUTH_ASSET_LINKS_CONFIGURATION",
        });
      const existing = packageFingerprints.get(packageName) ?? new Set<string>();
      for (const fp of fingerprints) {
        if (typeof fp === "string" && fp.trim()) existing.add(fp);
      }
      packageFingerprints.set(packageName, existing);
      const relations = packageRelations.get(packageName) ?? new Set<AndroidAssetLinksRelation>();
      for (const relation of parsed.statements[0]?.relation ?? []) relations.add(relation);
      packageRelations.set(packageName, relations);
    }

    const statements: AndroidAssetLinkStatement[] = [];
    for (const [packageName, fingerprints] of packageFingerprints) {
      if (fingerprints.size === 0) continue;
      statements.push({
        relation: [...(packageRelations.get(packageName) ?? [])],
        target: {
          namespace: "android_app",
          package_name: packageName,
          sha256_cert_fingerprints: Array.from(fingerprints),
        },
      });
    }

    return statements;
  },

  async findByHostedUrl(publicUrl: string): Promise<RegisteredMobileClientWithApp | null> {
    const rows = await dbWrite
      .select({
        client: mobileAppAuthClients,
        app: {
          id: apps.id,
          name: apps.name,
          description: apps.description,
          logo_url: apps.logo_url,
          website_url: apps.website_url,
          app_url: apps.app_url,
          allowed_origins: apps.allowed_origins,
          is_active: apps.is_active,
          is_approved: apps.is_approved,
        },
      })
      .from(mobileAppAuthClients)
      .innerJoin(apps, eq(apps.id, mobileAppAuthClients.app_id))
      .where(
        and(
          eq(mobileAppAuthClients.enabled, true),
          eq(apps.is_active, true),
          eq(apps.is_approved, true),
          or(
            eq(mobileAppAuthClients.redirect_uri, publicUrl),
            sql`regexp_replace(${mobileAppAuthClients.redirect_uri}, '/auth/callback$', '/billing/return') = ${publicUrl}`,
            sql`substring(${mobileAppAuthClients.redirect_uri} from '^https://[^/]+') || (${mobileAppAuthClients.browser_sign_in}->>'startPath') = ${publicUrl}`,
          ),
        ),
      );
    const selected = rows[0];
    if (
      selected &&
      rows.some(
        (row) =>
          row.app.id !== selected.app.id ||
          row.client.redirect_uri !== selected.client.redirect_uri ||
          (row.client.callback_android_package ?? row.client.android_package_name) !==
            (selected.client.callback_android_package ?? selected.client.android_package_name) ||
          JSON.stringify(row.client.browser_sign_in) !==
            JSON.stringify(selected.client.browser_sign_in),
      )
    )
      throw new ElizaError("Ambiguous hosted native callback registration", {
        code: "MOBILE_APP_AUTH_CALLBACK_AMBIGUOUS",
      });
    return rows[0] ?? null;
  },

  /**
   * Find an active client registration matching a callback redirect URI.
   */
  async findByRedirectUri(redirectUri: string): Promise<RegisteredMobileClientWithApp | null> {
    const rows = await dbWrite
      .select({
        client: mobileAppAuthClients,
        app: {
          id: apps.id,
          name: apps.name,
          description: apps.description,
          logo_url: apps.logo_url,
          website_url: apps.website_url,
          app_url: apps.app_url,
          allowed_origins: apps.allowed_origins,
          is_active: apps.is_active,
          is_approved: apps.is_approved,
        },
      })
      .from(mobileAppAuthClients)
      .innerJoin(apps, eq(apps.id, mobileAppAuthClients.app_id))
      .where(
        and(
          eq(mobileAppAuthClients.redirect_uri, redirectUri),
          eq(mobileAppAuthClients.enabled, true),
          eq(apps.is_active, true),
          eq(apps.is_approved, true),
        ),
      )
      .limit(1);

    if (rows.length === 0) return null;
    return rows[0]!;
  },
};
