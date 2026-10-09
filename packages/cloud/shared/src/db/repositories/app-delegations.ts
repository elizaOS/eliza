/** Persists app registration, consent-bound grants, and rotation fences on the primary database. */
import { randomBytes } from "node:crypto";
import { APP_DELEGATION_SCOPES, type AppDelegationScope } from "@elizaos/cloud-sdk/app-delegation";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { parseOidcClientEntry } from "../../lib/oidc/clients";
import { sha256Hex } from "../../lib/oidc/crypto";
import { validateAppBillingReturnUrl } from "../../lib/services/app-billing-return-url";
import {
  AppDelegationError,
  type AppDelegationGrant,
  type AppDelegationStore,
} from "../../lib/services/app-delegation";
import { dbWrite } from "../client";
import { appClientRegistrations, appDelegations } from "../schemas/app-delegations";
import { apps, appUsers } from "../schemas/apps";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";

export const registerAppClientSchema = z
  .object({
    billingReturnUrl: z.string().url().nullable().optional(),
    billingEnvironment: z.enum(["test", "live"]),
    redirectUris: z.array(z.string().url()).min(1),
    allowedScopes: z
      .array(z.enum(APP_DELEGATION_SCOPES))
      .min(1)
      .refine(
        (scopes) =>
          scopes.includes("identity") &&
          new Set(scopes).size === scopes.length &&
          (!scopes.some((scope) => scope.startsWith("google.")) ||
            scopes.includes("google.basic_identity")),
      ),
  })
  .strict();

export class AppDelegationsRepository implements AppDelegationStore {
  async findRegistration(clientId: string) {
    const [row] = await dbWrite
      .select({
        client: appClientRegistrations,
        app: { id: apps.id, name: apps.name, organization_id: apps.organization_id },
      })
      .from(appClientRegistrations)
      .innerJoin(apps, eq(apps.id, appClientRegistrations.app_id))
      .where(
        and(
          eq(appClientRegistrations.id, clientId),
          eq(appClientRegistrations.is_active, true),
          eq(appClientRegistrations.owner_organization_id, apps.organization_id),
          eq(apps.is_active, true),
          eq(apps.is_approved, true),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      id: row.client.id,
      billingEnvironment: row.client.billing_environment,
      appId: row.app.id,
      appName: row.app.name,
      appOwnerOrganizationId: row.app.organization_id,
      secretHashes: row.client.secret_hashes,
      redirectUris: row.client.redirect_uris,
      allowedScopes: row.client.allowed_scopes,
      revision: row.client.revision,
    };
  }

  async findPrincipal(appId: string, userId: string) {
    const [row] = await dbWrite
      .select({
        consentId: appUsers.id,
        id: users.id,
        organizationId: users.organization_id,
        email: users.email,
        name: users.name,
        emailVerified: users.email_verified,
        organizationActive: organizations.is_active,
      })
      .from(appUsers)
      .innerJoin(users, eq(users.id, appUsers.user_id))
      .leftJoin(organizations, eq(organizations.id, users.organization_id))
      .where(
        and(
          eq(appUsers.app_id, appId),
          eq(appUsers.user_id, userId),
          eq(users.is_active, true),
          eq(users.is_anonymous, false),
          isNull(users.deleted_at),
          or(isNull(users.expires_at), gt(users.expires_at, new Date())),
        ),
      )
      .limit(1);
    if (!row || (row.organizationId !== null && row.organizationActive !== true)) return null;
    return {
      consentId: row.consentId,
      user: {
        id: row.id,
        organizationId: row.organizationId,
        email: row.email,
        name: row.name,
        emailVerified: row.emailVerified === true,
      },
    };
  }

  async saveGrant(grant: AppDelegationGrant): Promise<boolean> {
    // The unique code digest is retained after revocation. A stale code-cache read cannot issue a second grant.
    const rows = await dbWrite
      .insert(appDelegations)
      .values({
        token_hash: grant.tokenHash,
        authorization_code_hash: grant.authorizationCodeHash,
        client_id: grant.clientId,
        app_id: grant.appId,
        user_id: grant.userId,
        organization_id: grant.organizationId,
        consent_id: grant.consentId,
        registration_revision: grant.registrationRevision,
        scopes: grant.scopes,
        expires_at: grant.expiresAt,
      })
      .onConflictDoNothing()
      .returning({ tokenHash: appDelegations.token_hash });
    return rows.length === 1;
  }

  async findGrant(tokenHash: string): Promise<AppDelegationGrant | null> {
    const [row] = await dbWrite
      .select()
      .from(appDelegations)
      .where(and(eq(appDelegations.token_hash, tokenHash), isNull(appDelegations.revoked_at)))
      .limit(1);
    return row
      ? {
          tokenHash: row.token_hash,
          authorizationCodeHash: row.authorization_code_hash,
          clientId: row.client_id,
          appId: row.app_id,
          userId: row.user_id,
          organizationId: row.organization_id,
          consentId: row.consent_id,
          registrationRevision: row.registration_revision,
          scopes: row.scopes,
          expiresAt: row.expires_at,
        }
      : null;
  }

  async revokeGrant(clientId: string, tokenHash: string, now: Date): Promise<void> {
    await dbWrite
      .update(appDelegations)
      .set({ revoked_at: now })
      .where(
        and(
          eq(appDelegations.client_id, clientId),
          eq(appDelegations.token_hash, tokenHash),
          isNull(appDelegations.revoked_at),
        ),
      );
  }

  async list(appId: string, ownerOrganizationId: string) {
    return dbWrite.transaction(async (tx) => {
      const [app] = await tx
        .select({ id: apps.id })
        .from(apps)
        .where(and(eq(apps.id, appId), eq(apps.organization_id, ownerOrganizationId)))
        .for("share");
      if (!app)
        throw new AppDelegationError(
          403,
          "APP_OWNER_REQUIRED",
          "The application owner must manage its clients",
        );
      const clients = await tx
        .select({
          clientId: appClientRegistrations.id,
          billingEnvironment: appClientRegistrations.billing_environment,
          billingReturnUrl: appClientRegistrations.billing_return_url,
          redirectUris: appClientRegistrations.redirect_uris,
          allowedScopes: appClientRegistrations.allowed_scopes,
          revision: appClientRegistrations.revision,
          active: appClientRegistrations.is_active,
          ownerOrganizationId: appClientRegistrations.owner_organization_id,
          createdAt: appClientRegistrations.created_at,
        })
        .from(appClientRegistrations)
        .where(eq(appClientRegistrations.app_id, appId))
        .orderBy(appClientRegistrations.created_at, appClientRegistrations.id);
      return clients.map(({ ownerOrganizationId: registeredOwner, createdAt, ...client }) => ({
        ...client,
        active: client.active && registeredOwner === ownerOrganizationId,
        createdAt: createdAt.toISOString(),
      }));
    });
  }

  async register(
    appId: string,
    ownerOrganizationId: string,
    input: {
      billingReturnUrl?: string | null;
      billingEnvironment: "test" | "live";
      redirectUris: string[];
      allowedScopes: AppDelegationScope[];
    },
  ) {
    const parsed = registerAppClientSchema.parse(input);
    const secret = randomBytes(32).toString("base64url");
    const digest = await sha256Hex(secret);
    return dbWrite.transaction(async (tx) => {
      const [app] = await tx
        .select({ id: apps.id, allowed_origins: apps.allowed_origins, app_url: apps.app_url })
        .from(apps)
        .where(
          and(
            eq(apps.id, appId),
            eq(apps.organization_id, ownerOrganizationId),
            eq(apps.is_active, true),
          ),
        )
        .for("update");
      if (!app)
        throw new AppDelegationError(
          403,
          "APP_OWNER_REQUIRED",
          "The application owner must register its client",
        );
      const allowedOrigins = new Set(
        [...app.allowed_origins, app.app_url].map((value) => new URL(value).origin),
      );
      const billingReturnUrl =
        parsed.billingReturnUrl == null
          ? null
          : validateAppBillingReturnUrl(parsed.billingReturnUrl, allowedOrigins);
      for (const uri of parsed.redirectUris) {
        const url = new URL(uri);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.hash ||
          !allowedOrigins.has(url.origin)
        )
          throw new AppDelegationError(
            400,
            "APP_REDIRECT_INVALID",
            "Register an exact HTTPS return URI on an allowed application origin",
          );
      }
      parseOidcClientEntry({
        client_id: app.id,
        client_secret_sha256: [digest],
        redirect_uris: parsed.redirectUris,
        allowed_scopes: ["openid"],
        claims_policy: { groups: false, roles: false, tenant_id: false, eliza_agents: false },
      });
      const [client] = await tx
        .insert(appClientRegistrations)
        .values({
          app_id: appId,
          billing_environment: parsed.billingEnvironment,
          billing_return_url: billingReturnUrl,
          owner_organization_id: ownerOrganizationId,
          secret_hashes: [digest],
          redirect_uris: parsed.redirectUris,
          allowed_scopes: parsed.allowedScopes,
        })
        .returning({
          id: appClientRegistrations.id,
          revision: appClientRegistrations.revision,
          billingEnvironment: appClientRegistrations.billing_environment,
        });
      if (!client)
        throw new AppDelegationError(
          503,
          "APP_REGISTRATION_UNAVAILABLE",
          "Application registration could not be persisted",
        );
      return {
        clientId: client.id,
        revision: client.revision,
        clientSecret: secret,
        billingEnvironment: parsed.billingEnvironment,
      };
    });
  }

  async rotate(appId: string, clientId: string, ownerOrganizationId: string, revoke: boolean) {
    const secret = revoke ? null : randomBytes(32).toString("base64url");
    const digest = secret ? await sha256Hex(secret) : null;
    return dbWrite.transaction(async (tx) => {
      const [app] = await tx
        .select({ id: apps.id })
        .from(apps)
        .where(and(eq(apps.id, appId), eq(apps.organization_id, ownerOrganizationId)))
        .for("update");
      if (!app)
        throw new AppDelegationError(
          403,
          "APP_OWNER_REQUIRED",
          "The application owner must rotate or revoke its client",
        );
      const [client] = await tx
        .update(appClientRegistrations)
        .set({
          ...(digest ? { secret_hashes: [digest] } : {}),
          owner_organization_id: ownerOrganizationId,
          is_active: !revoke,
          revision: sql`${appClientRegistrations.revision} + 1`,
          updated_at: new Date(),
        })
        .where(
          and(eq(appClientRegistrations.id, clientId), eq(appClientRegistrations.app_id, appId)),
        )
        .returning({
          id: appClientRegistrations.id,
          revision: appClientRegistrations.revision,
          billingEnvironment: appClientRegistrations.billing_environment,
        });
      if (!client)
        throw new AppDelegationError(
          404,
          "APP_CLIENT_NOT_FOUND",
          "Application client was not found",
        );
      await tx
        .update(appDelegations)
        .set({ revoked_at: new Date() })
        .where(and(eq(appDelegations.client_id, clientId), isNull(appDelegations.revoked_at)));
      return {
        clientId: client.id,
        revision: client.revision,
        clientSecret: secret,
        billingEnvironment: client.billingEnvironment,
      };
    });
  }
}

export const appDelegationsRepository = new AppDelegationsRepository();
