/**
 * Database-backed mobile App Auth client registrations and Digital Asset Links.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import type { AndroidAssetLinkStatement } from "../../lib/auth/android-asset-links";
import { dbRead, dbWrite } from "../client";
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
  async listActiveAndroidAssetLinks(): Promise<AndroidAssetLinkStatement[]> {
    const rows = await dbRead
      .select({
        packageName: mobileAppAuthClients.android_package_name,
        fingerprints: mobileAppAuthClients.android_cert_fingerprints,
      })
      .from(mobileAppAuthClients)
      .innerJoin(apps, eq(apps.id, mobileAppAuthClients.app_id))
      .where(
        and(
          eq(mobileAppAuthClients.enabled, true),
          isNotNull(mobileAppAuthClients.android_package_name),
          isNotNull(mobileAppAuthClients.android_cert_fingerprints),
          eq(apps.is_active, true),
          eq(apps.is_approved, true),
        ),
      );

    const packageFingerprints = new Map<string, Set<string>>();

    for (const row of rows) {
      const packageName = row.packageName;
      const fingerprints = row.fingerprints;
      if (!packageName || !Array.isArray(fingerprints) || fingerprints.length === 0) {
        continue;
      }
      const existing = packageFingerprints.get(packageName) ?? new Set<string>();
      for (const fp of fingerprints) {
        if (typeof fp === "string" && fp.trim()) existing.add(fp);
      }
      packageFingerprints.set(packageName, existing);
    }

    const statements: AndroidAssetLinkStatement[] = [];
    for (const [packageName, fingerprints] of packageFingerprints) {
      if (fingerprints.size === 0) continue;
      statements.push({
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: packageName,
          sha256_cert_fingerprints: Array.from(fingerprints),
        },
      });
    }

    return statements;
  },

  /**
   * Find an active client registration matching a callback redirect URI.
   */
  async findByRedirectUri(redirectUri: string): Promise<RegisteredMobileClientWithApp | null> {
    const rows = await dbRead
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
