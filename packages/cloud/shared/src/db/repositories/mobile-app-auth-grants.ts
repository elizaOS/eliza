/**
 * Primary-consistent persistence for first-party mobile App Auth grants.
 *
 * Exchange, credential creation, acknowledgement, activation, and expiry
 * cleanup are transactional so a response loss or concurrent request cannot
 * strand an active credential or mint two credentials for one code.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, count, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { dbWrite } from "../client";
import { buildMobileAppAuthCredentialProvenance } from "../mobile-app-auth-credential-policy";
import type { ApiKey, NewApiKey } from "../schemas/api-keys";
import { apiKeys } from "../schemas/api-keys";
import { apps } from "../schemas/apps";
import {
  type MobileAppAuthEnvironment,
  type MobileAppAuthGrant,
  mobileAppAuthGrants,
  type NewMobileAppAuthGrant,
} from "../schemas/mobile-app-auth-grants";
import { organizations } from "../schemas/organizations";
import { users } from "../schemas/users";

export interface MobileAppAuthGrantBinding {
  codeHash: string;
  appId: string;
  clientId: string;
  environment: MobileAppAuthEnvironment;
  redirectUri: string;
  stateHash: string;
  codeChallenge: string;
}

export interface MobileAppAuthGrantState {
  grant: MobileAppAuthGrant;
  credential: ApiKey | null;
}

export interface MobileAppAuthCleanupCursor {
  expiresAt: Date;
  createdAt: Date;
  id: string;
}

export type MobileAppAuthExchangeClaim =
  | { kind: "created"; state: MobileAppAuthGrantState }
  | { kind: "existing"; state: MobileAppAuthGrantState }
  | { kind: "invalid"; reason: "client_inactive" | "grant_invalid" };

export type MobileAppAuthRevealConfirmation =
  | { kind: "confirmed"; state: MobileAppAuthGrantState }
  | { kind: "invalid"; reason: "client_inactive" | "grant_invalid" };

function grantIntegrityError(message: string): ElizaError {
  return new ElizaError(message, {
    code: "MOBILE_APP_AUTH_GRANT_INTEGRITY",
    severity: "fatal",
  });
}

function exactBindingConditions(input: MobileAppAuthGrantBinding, now: Date) {
  return and(
    eq(mobileAppAuthGrants.code_hash, input.codeHash),
    eq(mobileAppAuthGrants.app_id, input.appId),
    eq(mobileAppAuthGrants.client_id, input.clientId),
    eq(mobileAppAuthGrants.environment, input.environment),
    eq(mobileAppAuthGrants.redirect_uri, input.redirectUri),
    eq(mobileAppAuthGrants.state_hash, input.stateHash),
    eq(mobileAppAuthGrants.code_challenge, input.codeChallenge),
    eq(mobileAppAuthGrants.code_challenge_method, "S256"),
    gt(mobileAppAuthGrants.expires_at, now),
  );
}

function assertStateIntegrity(state: MobileAppAuthGrantState): void {
  const { credential, grant } = state;
  if (grant.status === "pending") {
    if (grant.credential_id || credential) {
      throw grantIntegrityError("Pending mobile App Auth grant references a credential");
    }
    return;
  }
  if (grant.status === "acknowledged" && !grant.credential_id && !credential) {
    return;
  }
  if (!grant.credential_id || !credential) {
    throw grantIntegrityError("Exchanged mobile App Auth grant is missing its credential");
  }
  if (
    credential.id !== grant.credential_id ||
    credential.user_id !== grant.user_id ||
    credential.organization_id !== grant.organization_id ||
    credential.source_app_id !== grant.app_id
  ) {
    throw grantIntegrityError("Mobile App Auth grant credential ownership mismatch");
  }
  const expectedProvenance = buildMobileAppAuthCredentialProvenance({
    grantId: grant.id,
    environment: grant.environment,
    deviceName: grant.device_name,
    clientId: grant.client_id,
    scopes: grant.scopes,
  });
  if (
    credential.name !== expectedProvenance.name ||
    credential.description !== expectedProvenance.description
  ) {
    throw grantIntegrityError("Mobile App Auth credential provenance mismatch");
  }
}

export class MobileAppAuthGrantsRepository {
  async create(input: NewMobileAppAuthGrant): Promise<MobileAppAuthGrant | null> {
    return await dbWrite.transaction(async (tx) => {
      const [activeApp] = await tx
        .select({ id: apps.id })
        .from(apps)
        .where(and(eq(apps.id, input.app_id), eq(apps.is_active, true), eq(apps.is_approved, true)))
        .for("update");
      if (!activeApp) return null;
      const [created] = await tx.insert(mobileAppAuthGrants).values(input).returning();
      if (!created) throw grantIntegrityError("Failed to create mobile App Auth grant");
      return created;
    });
  }

  async findActiveState(
    binding: MobileAppAuthGrantBinding,
    now: Date,
  ): Promise<MobileAppAuthGrantState | null> {
    const [state] = await dbWrite
      .select({ grant: mobileAppAuthGrants, credential: apiKeys })
      .from(mobileAppAuthGrants)
      .leftJoin(apiKeys, eq(mobileAppAuthGrants.credential_id, apiKeys.id))
      .where(exactBindingConditions(binding, now))
      .limit(1);
    if (!state) return null;
    assertStateIntegrity(state);
    return state;
  }

  async findStateByCodeHash(codeHash: string): Promise<MobileAppAuthGrantState | null> {
    const [state] = await dbWrite
      .select({ grant: mobileAppAuthGrants, credential: apiKeys })
      .from(mobileAppAuthGrants)
      .leftJoin(apiKeys, eq(mobileAppAuthGrants.credential_id, apiKeys.id))
      .where(eq(mobileAppAuthGrants.code_hash, codeHash))
      .limit(1);
    if (!state) return null;
    assertStateIntegrity(state);
    return state;
  }

  /**
   * Linearizes plaintext delivery after external KMS work without holding a
   * database transaction open during decryption.
   */
  async confirmRevealable(input: {
    binding: MobileAppAuthGrantBinding;
    credentialId: string;
    credentialHash: string;
    now: Date;
  }): Promise<MobileAppAuthRevealConfirmation> {
    return await dbWrite.transaction(async (tx) => {
      const [activeApp] = await tx
        .select({ id: apps.id })
        .from(apps)
        .where(
          and(
            eq(apps.id, input.binding.appId),
            eq(apps.is_active, true),
            eq(apps.is_approved, true),
          ),
        )
        .for("update");
      if (!activeApp) return { kind: "invalid", reason: "client_inactive" };

      const [state] = await tx
        .select({ grant: mobileAppAuthGrants, credential: apiKeys })
        .from(mobileAppAuthGrants)
        .innerJoin(apiKeys, eq(mobileAppAuthGrants.credential_id, apiKeys.id))
        .where(
          and(
            exactBindingConditions(input.binding, input.now),
            eq(mobileAppAuthGrants.status, "exchanged"),
            eq(mobileAppAuthGrants.credential_id, input.credentialId),
            eq(apiKeys.id, input.credentialId),
            eq(apiKeys.key_hash, input.credentialHash),
            eq(apiKeys.is_active, false),
            isNull(apiKeys.deleted_at),
            gt(apiKeys.expires_at, input.now),
          ),
        )
        .limit(1);
      if (!state) return { kind: "invalid", reason: "grant_invalid" };
      assertStateIntegrity(state);
      return { kind: "confirmed", state };
    });
  }

  async exchange(
    binding: MobileAppAuthGrantBinding,
    credential: NewApiKey,
    now: Date,
  ): Promise<MobileAppAuthExchangeClaim> {
    return await dbWrite.transaction(async (tx) => {
      const [activeApp] = await tx
        .select({ id: apps.id })
        .from(apps)
        .where(
          and(eq(apps.id, binding.appId), eq(apps.is_active, true), eq(apps.is_approved, true)),
        )
        .for("update");
      if (!activeApp) return { kind: "invalid", reason: "client_inactive" };

      const [claimed] = await tx
        .update(mobileAppAuthGrants)
        .set({
          status: "exchanged",
          exchanged_at: now,
          updated_at: now,
        })
        .where(
          and(
            exactBindingConditions(binding, now),
            eq(mobileAppAuthGrants.status, "pending"),
            isNull(mobileAppAuthGrants.credential_id),
          ),
        )
        .returning();

      if (claimed) {
        if (credential.source_app_id !== claimed.app_id) {
          throw grantIntegrityError(
            "Mobile App Auth credential source app does not match its authorization grant",
          );
        }
        const [createdCredential] = await tx.insert(apiKeys).values(credential).returning();
        if (!createdCredential) {
          throw grantIntegrityError("Failed to create mobile App Auth credential");
        }
        const [boundGrant] = await tx
          .update(mobileAppAuthGrants)
          .set({ credential_id: createdCredential.id, updated_at: now })
          .where(
            and(
              eq(mobileAppAuthGrants.id, claimed.id),
              eq(mobileAppAuthGrants.status, "exchanged"),
              isNull(mobileAppAuthGrants.credential_id),
            ),
          )
          .returning();
        if (!boundGrant) {
          throw grantIntegrityError("Failed to bind mobile App Auth credential");
        }
        const state = { grant: boundGrant, credential: createdCredential };
        assertStateIntegrity(state);
        return { kind: "created", state };
      }

      const [existing] = await tx
        .select({ grant: mobileAppAuthGrants, credential: apiKeys })
        .from(mobileAppAuthGrants)
        .leftJoin(apiKeys, eq(mobileAppAuthGrants.credential_id, apiKeys.id))
        .where(exactBindingConditions(binding, now))
        .limit(1);
      if (!existing) return { kind: "invalid", reason: "grant_invalid" };
      assertStateIntegrity(existing);
      return { kind: "existing", state: existing };
    });
  }

  async acknowledge(input: {
    binding: MobileAppAuthGrantBinding;
    credentialId: string;
    credentialHash: string;
    now: Date;
  }): Promise<MobileAppAuthGrantState | null> {
    return await dbWrite.transaction(async (tx) => {
      const [activeApp] = await tx
        .select({ id: apps.id })
        .from(apps)
        .where(
          and(
            eq(apps.id, input.binding.appId),
            eq(apps.is_active, true),
            eq(apps.is_approved, true),
          ),
        )
        .for("update");
      if (!activeApp) return null;

      const [claimedGrant] = await tx
        .update(mobileAppAuthGrants)
        .set({
          status: "acknowledged",
          acknowledged_at: input.now,
          updated_at: input.now,
        })
        .where(
          and(
            exactBindingConditions(input.binding, input.now),
            eq(mobileAppAuthGrants.status, "exchanged"),
            eq(mobileAppAuthGrants.credential_id, input.credentialId),
          ),
        )
        .returning();

      if (claimedGrant) {
        const [owner] = await tx
          .select({ organizationId: users.organization_id, isActive: users.is_active })
          .from(users)
          .where(eq(users.id, claimedGrant.user_id))
          .for("update");
        if (!owner?.isActive || owner.organizationId !== claimedGrant.organization_id) {
          throw grantIntegrityError(
            "Mobile App Auth credential requires an active owner in the same organization",
          );
        }
        const [organization] = await tx
          .select({ isActive: organizations.is_active })
          .from(organizations)
          .where(eq(organizations.id, claimedGrant.organization_id))
          .for("update");
        if (!organization?.isActive) {
          throw grantIntegrityError("Mobile App Auth credential requires an active organization");
        }
        const expectedProvenance = buildMobileAppAuthCredentialProvenance({
          grantId: claimedGrant.id,
          environment: claimedGrant.environment,
          deviceName: claimedGrant.device_name,
          clientId: claimedGrant.client_id,
          scopes: claimedGrant.scopes,
        });
        const [activated] = await tx
          .update(apiKeys)
          .set({
            is_active: true,
            updated_at: input.now,
            key_ciphertext: null,
            key_nonce: null,
            key_auth_tag: null,
            key_kms_key_id: null,
            key_kms_key_version: null,
          })
          .where(
            and(
              eq(apiKeys.id, input.credentialId),
              eq(apiKeys.user_id, claimedGrant.user_id),
              eq(apiKeys.organization_id, claimedGrant.organization_id),
              eq(apiKeys.source_app_id, claimedGrant.app_id),
              eq(apiKeys.name, expectedProvenance.name),
              eq(apiKeys.description, expectedProvenance.description),
              eq(apiKeys.key_hash, input.credentialHash),
              eq(apiKeys.is_active, false),
              isNull(apiKeys.deleted_at),
              gt(apiKeys.expires_at, input.now),
            ),
          )
          .returning();
        if (!activated) {
          throw grantIntegrityError("Mobile App Auth credential could not be activated");
        }
        if (!activated.expires_at) {
          throw grantIntegrityError("Mobile App Auth credential must have a finite expiry");
        }
        const [receiptGrant] = await tx
          .update(mobileAppAuthGrants)
          .set({
            expires_at: activated.expires_at,
            updated_at: input.now,
          })
          .where(
            and(
              eq(mobileAppAuthGrants.id, claimedGrant.id),
              eq(mobileAppAuthGrants.status, "acknowledged"),
              eq(mobileAppAuthGrants.credential_id, activated.id),
            ),
          )
          .returning();
        if (!receiptGrant) {
          throw grantIntegrityError("Failed to retain mobile App Auth acknowledgement receipt");
        }
        const state = { grant: receiptGrant, credential: activated };
        assertStateIntegrity(state);
        return state;
      }

      const [existing] = await tx
        .select({ grant: mobileAppAuthGrants, credential: apiKeys })
        .from(mobileAppAuthGrants)
        .leftJoin(apiKeys, eq(mobileAppAuthGrants.credential_id, apiKeys.id))
        .where(exactBindingConditions(input.binding, input.now))
        .limit(1);
      if (!existing || existing.grant.status !== "acknowledged") return null;
      assertStateIntegrity(existing);
      if (
        existing.credential?.id !== input.credentialId ||
        existing.credential.key_hash !== input.credentialHash ||
        !existing.credential.is_active ||
        existing.credential.deleted_at ||
        (existing.credential.expires_at && existing.credential.expires_at <= input.now)
      ) {
        return null;
      }
      return existing;
    });
  }

  async cleanupExpired(
    now: Date,
    limit = 500,
    after?: MobileAppAuthCleanupCursor,
  ): Promise<{
    grantsDeleted: number;
    grantsScanned: number;
    inactiveCredentialsTombstoned: number;
    acknowledgedCredentialsTombstoned: number;
    integrityViolations: number;
    nextCursor: MobileAppAuthCleanupCursor | null;
  }> {
    return await dbWrite.transaction(async (tx) => {
      const afterCursor = after
        ? or(
            gt(mobileAppAuthGrants.expires_at, after.expiresAt),
            and(
              eq(mobileAppAuthGrants.expires_at, after.expiresAt),
              gt(mobileAppAuthGrants.created_at, after.createdAt),
            ),
            and(
              eq(mobileAppAuthGrants.expires_at, after.expiresAt),
              eq(mobileAppAuthGrants.created_at, after.createdAt),
              gt(mobileAppAuthGrants.id, after.id),
            ),
          )
        : undefined;
      const expired = await tx
        .select()
        .from(mobileAppAuthGrants)
        .where(and(lte(mobileAppAuthGrants.expires_at, now), afterCursor))
        .orderBy(
          asc(mobileAppAuthGrants.expires_at),
          asc(mobileAppAuthGrants.created_at),
          asc(mobileAppAuthGrants.id),
        )
        .limit(limit)
        .for("update", { skipLocked: true });
      if (expired.length === 0) {
        return {
          grantsDeleted: 0,
          grantsScanned: 0,
          inactiveCredentialsTombstoned: 0,
          acknowledgedCredentialsTombstoned: 0,
          integrityViolations: 0,
          nextCursor: null,
        };
      }
      const lastExpired = expired[expired.length - 1];
      if (!lastExpired) {
        throw grantIntegrityError("Expired mobile App Auth cleanup lost its scan cursor");
      }
      const nextCursor: MobileAppAuthCleanupCursor = {
        expiresAt: lastExpired.expires_at,
        createdAt: lastExpired.created_at,
        id: lastExpired.id,
      };

      const safeGrantIds = new Set(
        expired
          .filter(
            (grant) =>
              grant.status === "pending" &&
              grant.credential_id === null &&
              grant.exchanged_at === null &&
              grant.acknowledged_at === null,
          )
          .map((grant) => grant.id),
      );
      const credentialBearingGrants = expired.filter(
        (grant) => grant.status === "exchanged" || grant.status === "acknowledged",
      );
      const credentialIds = credentialBearingGrants
        .filter(
          (grant): grant is typeof grant & { credential_id: string } =>
            grant.credential_id !== null,
        )
        .map((grant) => grant.credential_id);

      let inactiveCredentialsTombstoned = 0;
      let acknowledgedCredentialsTombstoned = 0;
      let integrityViolations =
        expired.filter(
          (grant) =>
            grant.status === "pending" &&
            (grant.credential_id !== null ||
              grant.exchanged_at !== null ||
              grant.acknowledged_at !== null),
        ).length + credentialBearingGrants.filter((grant) => grant.credential_id === null).length;
      if (credentialIds.length > 0) {
        const uniqueCredentialIds = [...new Set(credentialIds)];
        const credentials = await tx
          .select()
          .from(apiKeys)
          .where(inArray(apiKeys.id, uniqueCredentialIds))
          .for("update");
        const referenceCounts = await tx
          .select({
            credentialId: mobileAppAuthGrants.credential_id,
            value: count(),
          })
          .from(mobileAppAuthGrants)
          .where(inArray(mobileAppAuthGrants.credential_id, uniqueCredentialIds))
          .groupBy(mobileAppAuthGrants.credential_id);
        const credentialById = new Map(
          credentials.map((credential) => [credential.id, credential]),
        );
        const referenceCountById = new Map(
          referenceCounts.flatMap((entry) =>
            entry.credentialId ? [[entry.credentialId, Number(entry.value)]] : [],
          ),
        );
        const inactiveTombstoneCandidates: Array<{ credentialId: string; grantId: string }> = [];
        const acknowledgedTombstoneCandidates: Array<{
          credentialId: string;
          grantId: string;
        }> = [];

        for (const grant of credentialBearingGrants) {
          const credentialId = grant.credential_id;
          if (!credentialId) continue;
          const credential = credentialById.get(credentialId);
          const expectedProvenance = buildMobileAppAuthCredentialProvenance({
            grantId: grant.id,
            environment: grant.environment,
            deviceName: grant.device_name,
            clientId: grant.client_id,
            scopes: grant.scopes,
          });
          const ownsCredential = Boolean(
            credential &&
              credential.user_id === grant.user_id &&
              credential.organization_id === grant.organization_id &&
              credential.source_app_id === grant.app_id &&
              credential.name === expectedProvenance.name &&
              credential.description === expectedProvenance.description &&
              referenceCountById.get(credentialId) === 1,
          );
          if (!credential || !ownsCredential) {
            integrityViolations++;
            continue;
          }
          if (!credential.expires_at) {
            integrityViolations++;
            continue;
          }
          const validLifecycleTimes =
            grant.exchanged_at !== null &&
            grant.exchanged_at <= now &&
            (grant.status === "exchanged"
              ? grant.acknowledged_at === null
              : grant.acknowledged_at !== null &&
                grant.acknowledged_at >= grant.exchanged_at &&
                grant.acknowledged_at <= now);
          if (!validLifecycleTimes) {
            integrityViolations++;
            continue;
          }
          if (credential.deleted_at) {
            if (
              credential.is_active ||
              credential.deleted_at > now ||
              credential.key_ciphertext !== null ||
              credential.key_nonce !== null ||
              credential.key_auth_tag !== null ||
              credential.key_kms_key_id !== null ||
              credential.key_kms_key_version !== null
            ) {
              integrityViolations++;
            } else {
              safeGrantIds.add(grant.id);
            }
            continue;
          }

          if (grant.status === "exchanged") {
            if (credential.is_active) {
              integrityViolations++;
              continue;
            }
            inactiveTombstoneCandidates.push({ credentialId, grantId: grant.id });
            continue;
          }

          const credentialExpiresAt = credential.expires_at;
          if (
            credentialExpiresAt > now ||
            credentialExpiresAt.getTime() !== grant.expires_at.getTime()
          ) {
            integrityViolations++;
            continue;
          }
          acknowledgedTombstoneCandidates.push({ credentialId, grantId: grant.id });
        }

        if (inactiveTombstoneCandidates.length > 0) {
          const candidateIds = inactiveTombstoneCandidates.map(
            (candidate) => candidate.credentialId,
          );
          const tombstoned = await tx
            .update(apiKeys)
            .set({
              is_active: false,
              deleted_at: now,
              updated_at: now,
              key_ciphertext: null,
              key_nonce: null,
              key_auth_tag: null,
              key_kms_key_id: null,
              key_kms_key_version: null,
            })
            .where(
              and(
                inArray(apiKeys.id, candidateIds),
                eq(apiKeys.is_active, false),
                isNull(apiKeys.deleted_at),
              ),
            )
            .returning({ id: apiKeys.id });
          inactiveCredentialsTombstoned = tombstoned.length;
          const tombstonedIds = new Set(tombstoned.map((credential) => credential.id));
          for (const candidate of inactiveTombstoneCandidates) {
            if (tombstonedIds.has(candidate.credentialId)) {
              safeGrantIds.add(candidate.grantId);
            } else {
              integrityViolations++;
            }
          }
        }

        if (acknowledgedTombstoneCandidates.length > 0) {
          const candidateIds = acknowledgedTombstoneCandidates.map(
            (candidate) => candidate.credentialId,
          );
          const tombstoned = await tx
            .update(apiKeys)
            .set({
              is_active: false,
              deleted_at: now,
              updated_at: now,
              key_ciphertext: null,
              key_nonce: null,
              key_auth_tag: null,
              key_kms_key_id: null,
              key_kms_key_version: null,
            })
            .where(
              and(
                inArray(apiKeys.id, candidateIds),
                lte(apiKeys.expires_at, now),
                isNull(apiKeys.deleted_at),
              ),
            )
            .returning({ id: apiKeys.id });
          acknowledgedCredentialsTombstoned = tombstoned.length;
          const tombstonedIds = new Set(tombstoned.map((credential) => credential.id));
          for (const candidate of acknowledgedTombstoneCandidates) {
            if (tombstonedIds.has(candidate.credentialId)) {
              safeGrantIds.add(candidate.grantId);
            } else {
              integrityViolations++;
            }
          }
        }
      }

      const safeIds = [...safeGrantIds];
      const deletedGrants =
        safeIds.length === 0
          ? []
          : await tx
              .delete(mobileAppAuthGrants)
              .where(inArray(mobileAppAuthGrants.id, safeIds))
              .returning({ id: mobileAppAuthGrants.id });
      if (deletedGrants.length !== safeIds.length) {
        throw grantIntegrityError("Expired mobile App Auth grant cleanup lost a locked row");
      }
      return {
        grantsDeleted: deletedGrants.length,
        grantsScanned: expired.length,
        inactiveCredentialsTombstoned,
        acknowledgedCredentialsTombstoned,
        integrityViolations,
        nextCursor,
      };
    });
  }

  async countExpired(now: Date): Promise<number> {
    const [row] = await dbWrite
      .select({ value: count() })
      .from(mobileAppAuthGrants)
      .where(lte(mobileAppAuthGrants.expires_at, now));
    if (!row) {
      throw grantIntegrityError("Failed to measure the expired mobile App Auth grant backlog");
    }
    return row.value;
  }
}

export const mobileAppAuthGrantsRepository = new MobileAppAuthGrantsRepository();
