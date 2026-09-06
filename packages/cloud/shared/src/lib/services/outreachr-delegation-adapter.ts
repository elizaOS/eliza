/** Binds Outreachr authorization and revocation to primary PostgreSQL state. */
import { and, eq, isNull } from "drizzle-orm";
import { dbWrite } from "../../db/client";
import { usersRepository } from "../../db/repositories/users";
import { apps } from "../../db/schemas/apps";
import { outreachrDelegations } from "../../db/schemas/outreachr-delegations";
import { consumeAppAuthCode } from "./app-auth-codes";
import { OutreachrDelegationError, OutreachrDelegationService } from "./outreachr-delegation";

export const outreachrDelegationService = new OutreachrDelegationService({
  async verifyRegistration(registration) {
    const [app] = await dbWrite
      .select({ isActive: apps.is_active, origins: apps.allowed_origins, appUrl: apps.app_url })
      .from(apps)
      .where(eq(apps.id, registration.appId))
      .limit(1);
    if (
      !app?.isActive ||
      ![...app.origins, app.appUrl].some(
        (value) => value === registration.origin || value === `${registration.origin}/`,
      )
    ) {
      throw new OutreachrDelegationError(
        503,
        "OUTREACHR_REGISTRATION_INVALID",
        "The registered Outreachr application is inactive or has a different origin",
      );
    }
  },
  consumeCode: consumeAppAuthCode,
  async findPrincipal(userId) {
    const user = await usersRepository.findByIdForWrite(userId);
    if (!user || !user.is_active || user.deleted_at || !user.organization_id) return null;
    return {
      id: user.id,
      organizationId: user.organization_id,
      email: user.email ?? "",
      name: user.name ?? "",
      emailVerified: user.email_verified === true,
    };
  },
  async saveGrant(key, grant) {
    // The unique code hash prevents two exchanges from minting credentials even
    // if the existing app-code cache returns a stale value during concurrent reads.
    const inserted = await dbWrite
      .insert(outreachrDelegations)
      .values({
        token_hash: key,
        authorization_code_hash: grant.authorizationCodeDigest,
        app_id: grant.appId,
        user_id: grant.userId,
        organization_id: grant.organizationId,
        registration_digest: grant.registrationDigest,
        expires_at: new Date(grant.expiresAt),
      })
      .onConflictDoNothing()
      .returning({ tokenHash: outreachrDelegations.token_hash });
    return inserted.length === 1;
  },
  async readGrant(key) {
    const [grant] = await dbWrite
      .select()
      .from(outreachrDelegations)
      .where(and(eq(outreachrDelegations.token_hash, key), isNull(outreachrDelegations.revoked_at)))
      .limit(1);
    return grant
      ? {
          authorizationCodeDigest: grant.authorization_code_hash,
          appId: grant.app_id,
          userId: grant.user_id,
          organizationId: grant.organization_id,
          registrationDigest: grant.registration_digest,
          expiresAt: grant.expires_at.getTime(),
        }
      : null;
  },
  async deleteGrant(key) {
    // Keep the code hash after revocation to reject a stale authorization-code replay.
    await dbWrite
      .update(outreachrDelegations)
      .set({ revoked_at: new Date() })
      .where(eq(outreachrDelegations.token_hash, key));
    return true;
  },
  now: () => Date.now(),
});
