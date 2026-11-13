/**
 * Primary-consistent persistence for first-party mobile App Auth grants.
 *
 * Exchange, credential creation, acknowledgement, activation, and expiry
 * cleanup are transactional so a response loss or concurrent request cannot
 * strand an active credential or mint two credentials for one code.
 *
 * Key renewal keeps a lineage. Every grant of one sign-in carries the same
 * session id, and a renewal grant names the credential that asked for it. A
 * predecessor has at most one live successor, a successor is exchanged and
 * activated only while its predecessor is still active, and revoking a
 * credential retires the rest of its session. The one exception is the last
 * step of a renewal, where the old credential revokes itself and names the
 * successor it was renewed into (see `MobileSessionRetirementCause`). Writers
 * that decide on a whole session take that session's advisory lock before any
 * credential row.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { withInferencePolicyMutation } from "../../lib/services/inference-policy-fence";
import { type DbTransaction, dbWrite } from "../client";
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

/**
 * Everything key renewal decides on, read in one primary statement: the
 * presented credential, the acknowledged grant that activated it, and the
 * current owner, organization and client app rows.
 */
export interface MobileAppAuthRenewalAuthority {
  credential: ApiKey;
  grant: MobileAppAuthGrant;
  owner: { isActive: boolean; organizationId: string | null } | null;
  organization: {
    isActive: boolean;
    lifecycleState: string;
    deletionRequestId: string | null;
  } | null;
  app: { isActive: boolean; isApproved: boolean } | null;
}

/**
 * Why a credential is being retired, which decides what goes with it:
 *  - `owner`: the account owner revoked the device, so the whole sign-in ends;
 *  - `self`: the credential revoked itself. This is the last step of a
 *    renewal, and only the credential itself ends, when the request names the
 *    credential's acknowledged successor (`MobileSelfRevocation`), or names
 *    nothing and arrives within `MOBILE_RENEWAL_RETIREMENT_GRACE_MS` of that
 *    successor's acknowledgement. Every other self-revocation is a sign-out
 *    and the sign-in ends, successors included: a holder that cannot name the
 *    successor does not hold it, so somebody else renewed this credential;
 *  - `reuse`: a credential that already has an acknowledged successor asked to
 *    renew again, so two holders exist and the whole sign-in ends, the
 *    presenting credential included.
 */
export type MobileSessionRetirementCause = "owner" | "self" | "reuse";

/**
 * How long after a successor's acknowledgement a self-revocation that names
 * no successor still counts as the last step of that renewal. It covers a
 * client that revokes the old key right after the acknowledgement without
 * naming the new one; a later request must name it.
 */
export const MOBILE_RENEWAL_RETIREMENT_GRACE_MS = 120_000;

/** What a self-revocation request carried, and when it is decided. */
export interface MobileSelfRevocation {
  /** The credential the caller says it was renewed into, or null. */
  successorCredentialId: string | null;
  now: Date;
}

export type MobileAppAuthRenewalClaim =
  | { kind: "created"; grant: MobileAppAuthGrant }
  | { kind: "invalid"; reason: "client_inactive" | "credential_invalid" }
  /** The predecessor already has an acknowledged successor. Nothing was written. */
  | { kind: "reused" };

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

type SessionReader = Pick<DbTransaction, "select">;

/** The session of a grant; a grant from before `session_id` is its own session. */
function sessionIdOf(grant: Pick<MobileAppAuthGrant, "id" | "session_id">): string {
  return grant.session_id ?? grant.id;
}

function inSession(sessionId: string) {
  return or(eq(mobileAppAuthGrants.session_id, sessionId), eq(mobileAppAuthGrants.id, sessionId));
}

async function lockSession(tx: DbTransaction, sessionId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile-app-auth-session:${sessionId}`}, 0))`,
  );
}

async function findGrantOfCredential(
  reader: SessionReader,
  credentialId: string,
): Promise<MobileAppAuthGrant | null> {
  const [grant] = await reader
    .select()
    .from(mobileAppAuthGrants)
    .where(eq(mobileAppAuthGrants.credential_id, credentialId))
    .limit(1);
  return grant ?? null;
}

/**
 * True when this self-revocation is the last step of a renewal: the
 * credential has an acknowledged successor, and the request either names that
 * successor or names nothing within the grace period after its
 * acknowledgement. A request that names any other credential is a sign-out.
 */
async function isRenewalLastStep(
  reader: SessionReader,
  credentialId: string,
  request: MobileSelfRevocation,
): Promise<boolean> {
  const [successor] = await reader
    .select({
      credentialId: mobileAppAuthGrants.credential_id,
      acknowledgedAt: mobileAppAuthGrants.acknowledged_at,
    })
    .from(mobileAppAuthGrants)
    .where(
      and(
        eq(mobileAppAuthGrants.renewed_from_credential_id, credentialId),
        eq(mobileAppAuthGrants.status, "acknowledged"),
      ),
    )
    .limit(1);
  if (!successor?.credentialId) return false;
  if (request.successorCredentialId !== null) {
    return request.successorCredentialId === successor.credentialId;
  }
  return (
    successor.acknowledgedAt !== null &&
    request.now.getTime() < successor.acknowledgedAt.getTime() + MOBILE_RENEWAL_RETIREMENT_GRACE_MS
  );
}

/**
 * The credentials that retiring `credentialId` for `cause` takes with it: the
 * not-yet-tombstoned credentials of its session, active or still awaiting
 * acknowledgement. The credential itself is included only for `reuse`.
 */
async function sessionRetirementCandidates(
  reader: SessionReader,
  credentialId: string,
  cause: MobileSessionRetirementCause,
  selfRevocation: MobileSelfRevocation,
): Promise<{ sessionId: string; credentials: ApiKey[] } | null> {
  const grant = await findGrantOfCredential(reader, credentialId);
  if (!grant) return null;
  const sessionId = sessionIdOf(grant);
  if (cause === "self" && (await isRenewalLastStep(reader, credentialId, selfRevocation))) {
    return { sessionId, credentials: [] };
  }
  const rows = await reader
    .select({ credential: apiKeys })
    .from(mobileAppAuthGrants)
    .innerJoin(apiKeys, eq(mobileAppAuthGrants.credential_id, apiKeys.id))
    .where(
      and(
        inSession(sessionId),
        eq(apiKeys.user_id, grant.user_id),
        eq(apiKeys.organization_id, grant.organization_id),
        eq(apiKeys.source_app_id, grant.app_id),
        isNull(apiKeys.deleted_at),
        cause === "reuse" ? undefined : ne(apiKeys.id, credentialId),
      ),
    )
    .orderBy(asc(apiKeys.id));
  return { sessionId, credentials: rows.map((row) => row.credential) };
}

/**
 * True unless this is a renewal grant whose predecessor is no longer an
 * active, unexpired credential. The predecessor row stays locked for the rest
 * of the transaction, so a revocation either committed before this read or
 * waits and then finds the successor this transaction wrote.
 */
async function predecessorAdmits(
  tx: DbTransaction,
  predecessorCredentialId: string | null,
  now: Date,
): Promise<boolean> {
  if (!predecessorCredentialId) return true;
  const [predecessor] = await tx
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, predecessorCredentialId),
        eq(apiKeys.is_active, true),
        isNull(apiKeys.deleted_at),
        gt(apiKeys.expires_at, now),
      ),
    )
    .for("update");
  return Boolean(predecessor);
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

  /**
   * Creates the successor grant of a key renewal. The session is locked and
   * the predecessor credential row is locked and re-read in the same
   * transaction, so a revocation that commits first leaves no code behind.
   * One that commits later does not strand a live successor either: exchange
   * and acknowledgement re-read the predecessor, and revocation retires the
   * session's other credentials.
   *
   * A predecessor has one live successor. A renewal that is still in flight
   * (its code not yet acknowledged) is superseded by the newer request; a
   * predecessor whose successor was already acknowledged is being reused and
   * gets no code at all.
   */
  async createRenewal(
    input: NewMobileAppAuthGrant,
    predecessor: { credentialId: string; keyHash: string },
    now: Date,
  ): Promise<MobileAppAuthRenewalClaim> {
    return await dbWrite.transaction(async (tx) => {
      const [activeApp] = await tx
        .select({ id: apps.id })
        .from(apps)
        .where(and(eq(apps.id, input.app_id), eq(apps.is_active, true), eq(apps.is_approved, true)))
        .for("update");
      if (!activeApp) return { kind: "invalid", reason: "client_inactive" };
      const [origin] = await tx
        .select()
        .from(mobileAppAuthGrants)
        .where(
          and(
            eq(mobileAppAuthGrants.credential_id, predecessor.credentialId),
            eq(mobileAppAuthGrants.status, "acknowledged"),
          ),
        )
        .limit(1);
      if (!origin) return { kind: "invalid", reason: "credential_invalid" };
      const sessionId = sessionIdOf(origin);
      await lockSession(tx, sessionId);
      const [credential] = await tx
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.id, predecessor.credentialId),
            eq(apiKeys.key_hash, predecessor.keyHash),
            eq(apiKeys.user_id, input.user_id),
            eq(apiKeys.organization_id, input.organization_id),
            eq(apiKeys.source_app_id, input.app_id),
            eq(apiKeys.is_active, true),
            isNull(apiKeys.deleted_at),
            gt(apiKeys.expires_at, now),
          ),
        )
        .for("update");
      if (!credential) return { kind: "invalid", reason: "credential_invalid" };

      const successors = await tx
        .select()
        .from(mobileAppAuthGrants)
        .where(eq(mobileAppAuthGrants.renewed_from_credential_id, predecessor.credentialId))
        .for("update");
      if (successors.some((grant) => grant.status === "acknowledged")) return { kind: "reused" };
      if (successors.length > 0) {
        // Supersede the renewal still in flight. Its code can no longer be
        // exchanged or acknowledged, and a credential it already minted is
        // tombstoned before it could ever be activated. The deadline moves to
        // the epoch, which is in the past of every request's captured time.
        const supersededCredentialIds = successors.flatMap((grant) =>
          grant.credential_id ? [grant.credential_id] : [],
        );
        await tx
          .update(mobileAppAuthGrants)
          .set({ expires_at: new Date(0), updated_at: now })
          .where(
            inArray(
              mobileAppAuthGrants.id,
              successors.map((grant) => grant.id),
            ),
          );
        if (supersededCredentialIds.length > 0) {
          await tx
            .update(apiKeys)
            .set({
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
                inArray(apiKeys.id, supersededCredentialIds),
                eq(apiKeys.is_active, false),
                isNull(apiKeys.deleted_at),
              ),
            );
        }
      }
      if (!origin.session_id) {
        // A grant from before the column is its own session from now on.
        await tx
          .update(mobileAppAuthGrants)
          .set({ session_id: sessionId })
          .where(
            and(eq(mobileAppAuthGrants.id, origin.id), isNull(mobileAppAuthGrants.session_id)),
          );
      }
      const [created] = await tx
        .insert(mobileAppAuthGrants)
        .values({
          ...input,
          session_id: sessionId,
          renewed_from_credential_id: predecessor.credentialId,
        })
        .returning();
      if (!created) throw grantIntegrityError("Failed to create mobile App Auth renewal grant");
      return { kind: "created", grant: created };
    });
  }

  /**
   * The credentials that retiring this one would take with it, read without
   * locks so the caller can fence them before the transaction that retires
   * them. `retireSessionInTransaction` decides again under the session lock.
   */
  async planSessionRetirement(
    credentialId: string,
    cause: MobileSessionRetirementCause,
    selfRevocation: MobileSelfRevocation,
  ): Promise<ApiKey[]> {
    return (
      (await sessionRetirementCandidates(dbWrite, credentialId, cause, selfRevocation))
        ?.credentials ?? []
    );
  }

  /**
   * Tombstones the credentials that retiring this one takes with it and
   * returns them. Call it before the credential's own tombstone, so the
   * session lock is taken ahead of any credential row. A credential with no
   * grant, or a renewal's last step, retires nothing here. `selfRevocation`
   * carries the time of the decision for every cause; its successor is read
   * only for `self`.
   */
  async retireSessionInTransaction(
    tx: DbTransaction,
    credentialId: string,
    cause: MobileSessionRetirementCause,
    selfRevocation: MobileSelfRevocation,
  ): Promise<ApiKey[]> {
    const now = selfRevocation.now;
    const origin = await findGrantOfCredential(tx, credentialId);
    if (!origin) return [];
    await lockSession(tx, sessionIdOf(origin));
    const plan = await sessionRetirementCandidates(tx, credentialId, cause, selfRevocation);
    if (!plan || plan.credentials.length === 0) return [];
    return await tx
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
          inArray(
            apiKeys.id,
            plan.credentials.map((credential) => credential.id),
          ),
          isNull(apiKeys.deleted_at),
          isNotNull(apiKeys.source_app_id),
        ),
      )
      .returning();
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

  /** The acknowledged grant that activated this credential; null for any other state. */
  async findAcknowledgedByCredentialId(credentialId: string): Promise<MobileAppAuthGrant | null> {
    const [grant] = await dbWrite
      .select()
      .from(mobileAppAuthGrants)
      .where(
        and(
          eq(mobileAppAuthGrants.credential_id, credentialId),
          eq(mobileAppAuthGrants.status, "acknowledged"),
        ),
      )
      .limit(1);
    return grant ?? null;
  }

  /**
   * The renewal authority of the credential with this secret hash, or null when
   * no credential has it or no acknowledged grant activated it. Reads the
   * primary only; a mobile secret never enters an auth cache.
   */
  async findRenewalAuthorityByKeyHash(
    keyHash: string,
  ): Promise<MobileAppAuthRenewalAuthority | null> {
    const [row] = await dbWrite
      .select({
        credential: apiKeys,
        grant: mobileAppAuthGrants,
        ownerId: users.id,
        ownerActive: users.is_active,
        ownerOrganizationId: users.organization_id,
        organizationId: organizations.id,
        organizationActive: organizations.is_active,
        organizationLifecycleState: organizations.account_lifecycle_state,
        organizationDeletionRequestId: organizations.account_deletion_request_id,
        appId: apps.id,
        appActive: apps.is_active,
        appApproved: apps.is_approved,
      })
      .from(apiKeys)
      .innerJoin(
        mobileAppAuthGrants,
        and(
          eq(mobileAppAuthGrants.credential_id, apiKeys.id),
          eq(mobileAppAuthGrants.status, "acknowledged"),
        ),
      )
      .leftJoin(users, eq(users.id, apiKeys.user_id))
      .leftJoin(organizations, eq(organizations.id, apiKeys.organization_id))
      .leftJoin(apps, eq(apps.id, mobileAppAuthGrants.app_id))
      .where(eq(apiKeys.key_hash, keyHash))
      .limit(1);
    if (!row) return null;
    return {
      credential: row.credential,
      grant: row.grant,
      owner: row.ownerId
        ? {
            isActive: row.ownerActive === true,
            organizationId: row.ownerOrganizationId,
          }
        : null,
      organization: row.organizationId
        ? {
            isActive: row.organizationActive === true,
            lifecycleState: String(row.organizationLifecycleState),
            deletionRequestId: row.organizationDeletionRequestId,
          }
        : null,
      app: row.appId
        ? {
            isActive: row.appActive === true,
            isApproved: row.appApproved === true,
          }
        : null,
    };
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
    return await withInferencePolicyMutation(
      {
        organizationIds: [credential.organization_id],
        userLockIds: [credential.user_id],
      },
      async (tx) => {
        const [activeApp] = await tx
          .select({ id: apps.id })
          .from(apps)
          .where(
            and(eq(apps.id, binding.appId), eq(apps.is_active, true), eq(apps.is_approved, true)),
          )
          .for("update");
        if (!activeApp) return { kind: "invalid", reason: "client_inactive" };

        // A renewal code is worth nothing once the credential that asked for
        // it was revoked or expired: no successor is minted for it.
        const [lineage] = await tx
          .select({
            predecessor: mobileAppAuthGrants.renewed_from_credential_id,
          })
          .from(mobileAppAuthGrants)
          .where(exactBindingConditions(binding, now))
          .limit(1);
        if (lineage && !(await predecessorAdmits(tx, lineage.predecessor, now))) {
          return { kind: "invalid", reason: "grant_invalid" };
        }

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
      },
    );
  }

  async acknowledge(input: {
    binding: MobileAppAuthGrantBinding;
    credentialId: string;
    credentialHash: string;
    now: Date;
  }): Promise<MobileAppAuthGrantState | null> {
    // Plan the locks before taking app, grant, owner or credential row locks.
    // The claim below rechecks this owner because a concurrent grant rewrite
    // must not move a credential into an organization outside this permit.
    const [planned] = await dbWrite
      .select({
        userId: mobileAppAuthGrants.user_id,
        organizationId: mobileAppAuthGrants.organization_id,
        predecessor: mobileAppAuthGrants.renewed_from_credential_id,
      })
      .from(mobileAppAuthGrants)
      .where(exactBindingConditions(input.binding, input.now))
      .limit(1);
    if (!planned) return null;
    return await withInferencePolicyMutation(
      {
        organizationIds: [planned.organizationId],
        userLockIds: [planned.userId],
      },
      async (tx) => {
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

        // A successor is activated only while the credential that asked for
        // it is still active. Revoking the predecessor between the renewal
        // request and this acknowledgement leaves the successor inactive, and
        // an already acknowledged successor is not confirmed again once the
        // session behind it was revoked.
        if (!(await predecessorAdmits(tx, planned.predecessor, input.now))) {
          const [settled] = await tx
            .select({ status: mobileAppAuthGrants.status })
            .from(mobileAppAuthGrants)
            .where(exactBindingConditions(input.binding, input.now))
            .limit(1);
          if (settled?.status !== "acknowledged") return null;
        }

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
              eq(mobileAppAuthGrants.user_id, planned.userId),
              eq(mobileAppAuthGrants.organization_id, planned.organizationId),
              eq(mobileAppAuthGrants.status, "exchanged"),
              eq(mobileAppAuthGrants.credential_id, input.credentialId),
              planned.predecessor
                ? eq(mobileAppAuthGrants.renewed_from_credential_id, planned.predecessor)
                : isNull(mobileAppAuthGrants.renewed_from_credential_id),
            ),
          )
          .returning();

        if (claimedGrant) {
          const [owner] = await tx
            .select({
              organizationId: users.organization_id,
              isActive: users.is_active,
            })
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
          .where(
            and(
              exactBindingConditions(input.binding, input.now),
              eq(mobileAppAuthGrants.user_id, planned.userId),
              eq(mobileAppAuthGrants.organization_id, planned.organizationId),
            ),
          )
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
      },
    );
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
    // A bounded read plans every user and organization lock before row locks.
    // Lock only that same candidate set, then verify ownership before writes.
    const planned = await dbWrite
      .select({
        id: mobileAppAuthGrants.id,
        userId: mobileAppAuthGrants.user_id,
        organizationId: mobileAppAuthGrants.organization_id,
        expiresAt: mobileAppAuthGrants.expires_at,
        createdAt: mobileAppAuthGrants.created_at,
      })
      .from(mobileAppAuthGrants)
      .where(and(lte(mobileAppAuthGrants.expires_at, now), afterCursor))
      .orderBy(
        asc(mobileAppAuthGrants.expires_at),
        asc(mobileAppAuthGrants.created_at),
        asc(mobileAppAuthGrants.id),
      )
      .limit(limit);
    const plannedById = new Map(planned.map((grant) => [grant.id, grant]));
    // Scan counts include planned candidates skipped by a row lock. Advance
    // across those candidates as well as processed rows. The next sweep
    // starts at the beginning and retries grants still held by another writer.
    const lastPlanned = planned[planned.length - 1];
    const nextCursor: MobileAppAuthCleanupCursor | null = lastPlanned
      ? {
          expiresAt: lastPlanned.expiresAt,
          createdAt: lastPlanned.createdAt,
          id: lastPlanned.id,
        }
      : null;
    return await withInferencePolicyMutation(
      {
        organizationIds: planned.map((grant) => grant.organizationId),
        userLockIds: planned.map((grant) => grant.userId),
      },
      async (tx) => {
        const expired = await tx
          .select()
          .from(mobileAppAuthGrants)
          .where(
            and(
              lte(mobileAppAuthGrants.expires_at, now),
              afterCursor,
              inArray(
                mobileAppAuthGrants.id,
                planned.map((grant) => grant.id),
              ),
            ),
          )
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
            grantsScanned: planned.length,
            inactiveCredentialsTombstoned: 0,
            acknowledgedCredentialsTombstoned: 0,
            integrityViolations: 0,
            nextCursor,
          };
        }
        for (const grant of expired) {
          const owner = plannedById.get(grant.id);
          if (owner?.userId !== grant.user_id || owner.organizationId !== grant.organization_id)
            throw grantIntegrityError("Expired mobile App Auth grant owner changed during cleanup");
        }

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
          const inactiveTombstoneCandidates: Array<{
            credentialId: string;
            grantId: string;
          }> = [];
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
              inactiveTombstoneCandidates.push({
                credentialId,
                grantId: grant.id,
              });
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
            acknowledgedTombstoneCandidates.push({
              credentialId,
              grantId: grant.id,
            });
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
          grantsScanned: planned.length,
          inactiveCredentialsTombstoned,
          acknowledgedCredentialsTombstoned,
          integrityViolations,
          nextCursor,
        };
      },
    );
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
