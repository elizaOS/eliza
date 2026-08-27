/** Multi-principal consent authority for one Personal Shared provider group. */
import { ElizaError } from "@elizaos/core/edge";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Database, DbTransaction } from "../client";
import { dbWrite } from "../client";
import { organizations } from "../schemas/organizations";
import {
  type PersonalSharedGroupConsentMode,
  type PersonalSharedGroupJoinChallenge,
  type PersonalSharedGroupPlatform,
  personalSharedGroupBindings,
  personalSharedGroupJoinChallenges,
  personalSharedGroupParticipants,
} from "../schemas/personal-shared-groups";
import { users } from "../schemas/users";

const AUTHORITY_MUTATION_WAIT_MS = 5_000;
const AUTHORITY_MUTATION_POLL_MS = 25;
const MAX_JOIN_CHALLENGE_TTL_MS = 15 * 60_000;

export interface PersonalSharedGroupConsentStatus {
  mode: PersonalSharedGroupConsentMode;
  gate: "enabled" | "restricted";
  requiredPrincipalCount: number;
  registeredParticipantCount: number;
  linkedParticipantCount: number;
  consentedParticipantCount: number;
  participants: Array<{
    ordinal: number;
    isOwner: boolean;
    linked: boolean;
    consented: boolean;
    revoked: boolean;
  }>;
}

export type PersonalSharedGroupJoinChallengeFailure =
  | "invalid"
  | "expired"
  | "already_used"
  | "wrong_sender"
  | "wrong_scope"
  | "stale"
  | "actor_not_registered"
  | "account_not_authenticated"
  | "already_linked";

export type IssuePersonalSharedGroupJoinChallengeResult =
  | { status: "issued"; consentVersion: number }
  | {
      status:
        | "invalid"
        | "expired"
        | "already_used"
        | "wrong_scope"
        | "stale"
        | "actor_not_registered"
        | "already_linked";
    };

export type ConsumePersonalSharedGroupJoinAuthenticateResult =
  | { status: "confirm_issued"; bindingId: string; consentVersion: number }
  | { status: PersonalSharedGroupJoinChallengeFailure };

export type ConsumePersonalSharedGroupJoinConfirmResult =
  | { status: "consented"; consent: PersonalSharedGroupConsentStatus }
  | { status: PersonalSharedGroupJoinChallengeFailure };

export type PersonalSharedGroupSelfRevokeResult =
  | { status: "revoked"; consent: PersonalSharedGroupConsentStatus }
  | { status: "invalid" | "wrong_sender" | "not_linked" | "owner_forbidden" };

type AuthorityMutationAttempt<T> = { blocked: true } | { blocked: false; result: T };

function normalizedThreadId(providerThreadId: string | null | undefined): string {
  return providerThreadId ?? "";
}

function deliveryLeaseAllowsAuthorityMutation(now: Date) {
  return or(
    isNull(personalSharedGroupBindings.delivery_lease_source_id),
    isNotNull(personalSharedGroupBindings.delivery_lease_committed_at),
    lte(personalSharedGroupBindings.delivery_lease_expires_at, now),
  );
}

function deliveryLeaseBlocksAuthorityMutation(now: Date) {
  return and(
    isNull(personalSharedGroupBindings.delivery_lease_committed_at),
    gt(personalSharedGroupBindings.delivery_lease_expires_at, now),
  )!;
}

function consentInputError(message: string, context: Record<string, unknown>): ElizaError {
  return new ElizaError(message, {
    code: "PERSONAL_SHARED_GROUP_CONSENT_INPUT_INVALID",
    severity: "fatal",
    context,
  });
}

function consentDeliveryPendingError(): ElizaError {
  return new ElizaError("A live group delivery reservation is still pending", {
    code: "PERSONAL_SHARED_GROUP_DELIVERY_PENDING",
    severity: "fatal",
  });
}

function assertChallengeInput(input: {
  codeHash: string;
  expiresAt?: Date;
  bindingId?: string;
  platform: PersonalSharedGroupPlatform;
  project: string;
  connectorAccountId: string;
  actorPlatformUserId: string;
}): void {
  if (
    !/^[a-f\d]{64}$/i.test(input.codeHash) ||
    (input.bindingId !== undefined && !input.bindingId) ||
    !input.project ||
    !input.connectorAccountId ||
    !input.actorPlatformUserId
  ) {
    throw consentInputError("Personal Shared group join challenge input is incomplete", {
      bindingId: input.bindingId,
    });
  }
  if (input.expiresAt) {
    const ttlMs = input.expiresAt.getTime() - Date.now();
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_JOIN_CHALLENGE_TTL_MS) {
      throw consentInputError("Personal Shared group join challenge expiry is invalid", {
        bindingId: input.bindingId,
      });
    }
  }
}

async function withConsentStorageBoundary<T>(
  operation: () => Promise<T>,
  context: Record<string, unknown>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ElizaError) throw error;
    // error-policy:J2 consent persistence is fail-closed. The route converts
    // this typed boundary into one structured internal delivery failure.
    throw new ElizaError("Personal Shared group consent storage failed", {
      code: "PERSONAL_SHARED_GROUP_CONSENT_STORAGE_FAILURE",
      severity: "fatal",
      context,
      cause: error,
    });
  }
}

async function waitForAuthorityMutation<T>(
  mutation: () => Promise<AuthorityMutationAttempt<T>>,
): Promise<T> {
  const deadline = Date.now() + AUTHORITY_MUTATION_WAIT_MS;
  while (true) {
    const attempt = await mutation();
    if (!attempt.blocked) return attempt.result;
    if (Date.now() >= deadline) throw consentDeliveryPendingError();
    await new Promise((resolve) => setTimeout(resolve, AUTHORITY_MUTATION_POLL_MS));
  }
}

async function hasActiveOrganization(
  tx: DbTransaction,
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!organizationId) return false;
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), eq(organizations.is_active, true)))
    .limit(1);
  return Boolean(organization);
}

async function deriveConsentStatusInTransaction(
  tx: DbTransaction,
  bindingId: string,
): Promise<PersonalSharedGroupConsentStatus | null> {
  const [binding] = await tx
    .select({
      state: personalSharedGroupBindings.state,
      ownerUserId: personalSharedGroupBindings.owner_user_id,
      platform: personalSharedGroupBindings.platform,
      mode: personalSharedGroupBindings.consent_mode,
      requiredPrincipalCount: personalSharedGroupBindings.required_principal_count,
    })
    .from(personalSharedGroupBindings)
    .where(eq(personalSharedGroupBindings.id, bindingId))
    .limit(1);
  if (!binding) return null;

  const rows = await tx
    .select({
      ordinal: personalSharedGroupParticipants.ordinal,
      platformUserId: personalSharedGroupParticipants.platform_user_id,
      linkedUserId: personalSharedGroupParticipants.linked_user_id,
      consentedAt: personalSharedGroupParticipants.consented_at,
      revokedAt: personalSharedGroupParticipants.revoked_at,
      userId: users.id,
      stewardUserId: users.steward_user_id,
      telegramId: users.telegram_id,
      phoneNumber: users.phone_number,
      phoneVerified: users.phone_verified,
      isAnonymous: users.is_anonymous,
      isActive: users.is_active,
      deletedAt: users.deleted_at,
      organizationActive: organizations.is_active,
    })
    .from(personalSharedGroupParticipants)
    .leftJoin(users, eq(users.id, personalSharedGroupParticipants.linked_user_id))
    .leftJoin(organizations, eq(organizations.id, users.organization_id))
    .where(eq(personalSharedGroupParticipants.binding_id, bindingId))
    .orderBy(asc(personalSharedGroupParticipants.ordinal));
  const active = rows.filter((row) => row.revokedAt === null);
  const isEligibleLinkedParticipant = (row: (typeof rows)[number]): boolean =>
    row.revokedAt === null &&
    row.linkedUserId !== null &&
    row.userId === row.linkedUserId &&
    row.organizationActive === true &&
    row.isActive === true &&
    row.deletedAt === null &&
    row.isAnonymous === false &&
    typeof row.stewardUserId === "string" &&
    !row.stewardUserId.startsWith("phone:") &&
    !row.stewardUserId.startsWith("telegram:") &&
    (binding.platform === "blooio"
      ? row.phoneNumber === row.platformUserId && row.phoneVerified === true
      : row.telegramId === row.platformUserId);
  const linked = active.filter(isEligibleLinkedParticipant);
  const consented = linked.filter((row) => row.consentedAt !== null);
  const ownerConsented = consented.some((row) => row.linkedUserId === binding.ownerUserId);
  const enabled =
    binding.state === "active" &&
    (binding.mode === "single_owner" ||
      (ownerConsented && consented.length >= binding.requiredPrincipalCount));

  return {
    mode: binding.mode,
    gate: enabled ? "enabled" : "restricted",
    requiredPrincipalCount: binding.requiredPrincipalCount,
    registeredParticipantCount: active.length,
    linkedParticipantCount: linked.length,
    consentedParticipantCount: consented.length,
    participants: rows.map((row) => {
      const revoked = row.revokedAt !== null;
      const linkedParticipant = isEligibleLinkedParticipant(row);
      return {
        ordinal: row.ordinal,
        isOwner: linkedParticipant && row.linkedUserId === binding.ownerUserId,
        linked: linkedParticipant,
        consented: linkedParticipant && row.consentedAt !== null,
        revoked,
      };
    }),
  };
}

function classifyChallenge(
  challenge: PersonalSharedGroupJoinChallenge | undefined,
  input: {
    stage: "authenticate" | "confirm";
    now: Date;
    bindingId?: string;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId?: string;
    providerThreadId?: string | null;
    actorPlatformUserId: string;
  },
): PersonalSharedGroupJoinChallengeFailure | null {
  if (!challenge || challenge.stage !== input.stage) return "invalid";
  if (challenge.consumed_at) return "already_used";
  if (challenge.expires_at <= input.now) return "expired";
  if (challenge.issued_to_platform_user_id !== input.actorPlatformUserId) {
    return "wrong_sender";
  }
  if (
    challenge.platform !== input.platform ||
    challenge.project !== input.project ||
    challenge.connector_account_id !== input.connectorAccountId ||
    (input.bindingId !== undefined && challenge.binding_id !== input.bindingId) ||
    (input.providerChatId !== undefined && challenge.provider_chat_id !== input.providerChatId) ||
    (input.providerThreadId !== undefined &&
      challenge.provider_thread_id !== normalizedThreadId(input.providerThreadId))
  ) {
    return "wrong_scope";
  }
  return null;
}

export class PersonalSharedGroupConsentRepository {
  constructor(private readonly database: Database) {}

  async issueJoinAuthenticateChallenge(input: {
    codeHash: string;
    sourceMessageId?: string;
    bindingId: string;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    providerThreadId?: string | null;
    actorPlatformUserId: string;
    expiresAt: Date;
  }): Promise<IssuePersonalSharedGroupJoinChallengeResult> {
    assertChallengeInput(input);
    if (!input.providerChatId) {
      throw consentInputError("Personal Shared group join destination is incomplete", {
        bindingId: input.bindingId,
      });
    }
    return withConsentStorageBoundary(
      () =>
        this.database.transaction(async (tx) => {
          const now = new Date();
          const [binding] = await tx
            .select({
              id: personalSharedGroupBindings.id,
              consentVersion: personalSharedGroupBindings.consent_version,
            })
            .from(personalSharedGroupBindings)
            .where(
              and(
                eq(personalSharedGroupBindings.id, input.bindingId),
                eq(personalSharedGroupBindings.platform, input.platform),
                eq(personalSharedGroupBindings.project, input.project),
                eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
                eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
                eq(personalSharedGroupBindings.state, "active"),
                eq(personalSharedGroupBindings.consent_mode, "all_adults"),
              ),
            )
            .limit(1)
            .for("update");
          if (!binding) {
            const [byId] = await tx
              .select({ id: personalSharedGroupBindings.id })
              .from(personalSharedGroupBindings)
              .where(eq(personalSharedGroupBindings.id, input.bindingId))
              .limit(1);
            return { status: byId ? "wrong_scope" : "invalid" } as const;
          }
          const sourceMessageId = input.sourceMessageId ?? input.codeHash;
          const [sourceReplay] = await tx
            .select()
            .from(personalSharedGroupJoinChallenges)
            .where(
              and(
                eq(personalSharedGroupJoinChallenges.binding_id, input.bindingId),
                eq(personalSharedGroupJoinChallenges.stage, "authenticate"),
                eq(
                  personalSharedGroupJoinChallenges.issued_to_platform_user_id,
                  input.actorPlatformUserId,
                ),
                eq(personalSharedGroupJoinChallenges.source_message_id, sourceMessageId),
              ),
            )
            .limit(1)
            .for("update");
          if (sourceReplay) {
            const sameImmutableIssue =
              sourceReplay.code_hash === input.codeHash &&
              sourceReplay.platform === input.platform &&
              sourceReplay.project === input.project &&
              sourceReplay.connector_account_id === input.connectorAccountId &&
              sourceReplay.provider_chat_id === input.providerChatId &&
              sourceReplay.provider_thread_id === normalizedThreadId(input.providerThreadId);
            if (!sameImmutableIssue) return { status: "wrong_scope" } as const;
            if (sourceReplay.consent_version !== binding.consentVersion) {
              return { status: "stale" } as const;
            }
            if (sourceReplay.superseded_at !== null) {
              return { status: "already_used" } as const;
            }
            if (sourceReplay.expires_at <= now) return { status: "expired" } as const;
            // Normal consumption is replay-safe: a provider response-loss
            // replay returns the same deterministic displayed code without
            // mutating a later flow. Explicit supersession is handled above.
            return { status: "issued", consentVersion: sourceReplay.consent_version } as const;
          }
          // Every challenge mutation for a binding takes the binding lock
          // first. This serializes the no-existing-row issuance case and keeps
          // reissue, consume, account lifecycle, and FK cascades on one lock
          // order instead of participant<->challenge inversion.
          const priorActorChallenges = await tx
            .select({ id: personalSharedGroupJoinChallenges.id })
            .from(personalSharedGroupJoinChallenges)
            .where(
              and(
                eq(personalSharedGroupJoinChallenges.binding_id, input.bindingId),
                eq(
                  personalSharedGroupJoinChallenges.issued_to_platform_user_id,
                  input.actorPlatformUserId,
                ),
              ),
            )
            .orderBy(personalSharedGroupJoinChallenges.id)
            .for("update");
          if (priorActorChallenges.length > 0) {
            // Retain durable source tombstones for the binding's lifetime.
            // Gateway dedupe has a finite horizon, so deleting an older source
            // would let a delayed provider retry recreate its deterministic
            // code with a fresh TTL and displace a newer flow. Binding deletion
            // remains the explicit retention boundary through the FK cascade.
            await tx
              .update(personalSharedGroupJoinChallenges)
              .set({
                consumed_at: sql`COALESCE(${personalSharedGroupJoinChallenges.consumed_at}, ${now})`,
                superseded_at: now,
                superseded_by_source_message_id: sourceMessageId,
              })
              .where(
                inArray(
                  personalSharedGroupJoinChallenges.id,
                  priorActorChallenges.map(({ id }) => id),
                ),
              );
          }

          const [participant] = await tx
            .select({
              linkedUserId: personalSharedGroupParticipants.linked_user_id,
              consentedAt: personalSharedGroupParticipants.consented_at,
              revokedAt: personalSharedGroupParticipants.revoked_at,
            })
            .from(personalSharedGroupParticipants)
            .where(
              and(
                eq(personalSharedGroupParticipants.binding_id, input.bindingId),
                eq(personalSharedGroupParticipants.platform_user_id, input.actorPlatformUserId),
              ),
            )
            .limit(1)
            .for("update");
          if (!participant) return { status: "actor_not_registered" } as const;
          if (
            participant.revokedAt === null &&
            participant.linkedUserId !== null &&
            participant.consentedAt !== null
          ) {
            return { status: "already_linked" } as const;
          }
          await tx.insert(personalSharedGroupJoinChallenges).values({
            code_hash: input.codeHash,
            stage: "authenticate",
            binding_id: input.bindingId,
            consent_version: binding.consentVersion,
            platform: input.platform,
            project: input.project,
            connector_account_id: input.connectorAccountId,
            provider_chat_id: input.providerChatId,
            provider_thread_id: normalizedThreadId(input.providerThreadId),
            issued_to_platform_user_id: input.actorPlatformUserId,
            source_message_id: sourceMessageId,
            expires_at: input.expiresAt,
          });
          return { status: "issued", consentVersion: binding.consentVersion } as const;
        }),
      { bindingId: input.bindingId },
    );
  }

  async consumeJoinAuthenticateChallenge(input: {
    codeHash: string;
    confirmCodeHash: string;
    sourceMessageId?: string;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    actorPlatformUserId: string;
    linkedUserId: string;
    linkedOrganizationId: string;
    expiresAt: Date;
  }): Promise<ConsumePersonalSharedGroupJoinAuthenticateResult> {
    assertChallengeInput(input);
    assertChallengeInput({ ...input, codeHash: input.confirmCodeHash });
    if (!input.linkedUserId || !input.linkedOrganizationId) {
      throw consentInputError("Authenticated Personal Shared group account is incomplete", {});
    }
    return withConsentStorageBoundary(
      () =>
        this.database.transaction(async (tx) => {
          const now = new Date();
          const sourceMessageId = input.sourceMessageId ?? input.confirmCodeHash;
          const [observedChallenge] = await tx
            .select()
            .from(personalSharedGroupJoinChallenges)
            .where(eq(personalSharedGroupJoinChallenges.code_hash, input.codeHash))
            .limit(1);
          if (!observedChallenge) return { status: "invalid" } as const;
          const observedFailure = classifyChallenge(observedChallenge, {
            stage: "authenticate",
            now,
            platform: input.platform,
            project: input.project,
            connectorAccountId: input.connectorAccountId,
            actorPlatformUserId: input.actorPlatformUserId,
          });
          if (observedFailure && observedFailure !== "already_used") {
            return { status: observedFailure };
          }

          // User-associated authority paths lock the durable account first.
          // Account deactivation/deletion uses the same U -> B -> C -> P order,
          // so no confirmation can appear after lifecycle discovery and later
          // resurrect when the account is reactivated.
          const [linkedUser] = await tx
            .select({
              organizationId: users.organization_id,
              stewardUserId: users.steward_user_id,
              telegramId: users.telegram_id,
              phoneNumber: users.phone_number,
              phoneVerified: users.phone_verified,
              isAnonymous: users.is_anonymous,
              isActive: users.is_active,
              deletedAt: users.deleted_at,
            })
            .from(users)
            .where(eq(users.id, input.linkedUserId))
            .limit(1)
            .for("update");
          const matureSubject =
            linkedUser &&
            !linkedUser.stewardUserId.startsWith("phone:") &&
            !linkedUser.stewardUserId.startsWith("telegram:");
          const providerIdentityMatches =
            linkedUser &&
            (input.platform === "blooio"
              ? linkedUser.phoneNumber === input.actorPlatformUserId &&
                linkedUser.phoneVerified === true
              : linkedUser.telegramId === input.actorPlatformUserId);
          const activeOrganization = await hasActiveOrganization(tx, linkedUser?.organizationId);
          if (
            !linkedUser ||
            linkedUser.organizationId !== input.linkedOrganizationId ||
            !activeOrganization ||
            !linkedUser.isActive ||
            linkedUser.deletedAt !== null ||
            linkedUser.isAnonymous ||
            !matureSubject ||
            !providerIdentityMatches
          ) {
            return { status: "account_not_authenticated" } as const;
          }

          const [binding] = await tx
            .select({
              id: personalSharedGroupBindings.id,
              consentVersion: personalSharedGroupBindings.consent_version,
            })
            .from(personalSharedGroupBindings)
            .where(
              and(
                eq(personalSharedGroupBindings.id, observedChallenge.binding_id),
                eq(personalSharedGroupBindings.state, "active"),
                eq(personalSharedGroupBindings.consent_mode, "all_adults"),
              ),
            )
            .limit(1)
            .for("update");
          if (!binding) return { status: "stale" } as const;

          const [challenge] = await tx
            .select()
            .from(personalSharedGroupJoinChallenges)
            .where(eq(personalSharedGroupJoinChallenges.id, observedChallenge.id))
            .limit(1)
            .for("update");
          const priorConfirms = await tx
            .select()
            .from(personalSharedGroupJoinChallenges)
            .where(
              and(
                eq(personalSharedGroupJoinChallenges.binding_id, observedChallenge.binding_id),
                eq(personalSharedGroupJoinChallenges.stage, "confirm"),
                eq(
                  personalSharedGroupJoinChallenges.issued_to_platform_user_id,
                  input.actorPlatformUserId,
                ),
              ),
            )
            .orderBy(personalSharedGroupJoinChallenges.id)
            .for("update");
          const failure = classifyChallenge(challenge, {
            stage: "authenticate",
            now,
            platform: input.platform,
            project: input.project,
            connectorAccountId: input.connectorAccountId,
            actorPlatformUserId: input.actorPlatformUserId,
          });
          if (failure === "already_used" && input.sourceMessageId !== undefined) {
            const replay = priorConfirms.find(
              (confirm) =>
                challenge?.consumed_by_source_message_id === sourceMessageId &&
                confirm.source_message_id === sourceMessageId &&
                confirm.code_hash === input.confirmCodeHash &&
                confirm.linked_user_id === input.linkedUserId &&
                confirm.consumed_at === null &&
                confirm.expires_at > now,
            );
            return replay
              ? {
                  status: "confirm_issued" as const,
                  bindingId: replay.binding_id,
                  consentVersion: replay.consent_version,
                }
              : { status: "already_used" as const };
          }
          if (failure) return { status: failure };
          if (!challenge) return { status: "invalid" } as const;
          if (
            binding.consentVersion !== challenge.consent_version ||
            challenge.binding_id !== binding.id ||
            challenge.platform !== input.platform ||
            challenge.project !== input.project ||
            challenge.connector_account_id !== input.connectorAccountId
          ) {
            return { status: "stale" } as const;
          }

          const [participant] = await tx
            .select({
              id: personalSharedGroupParticipants.id,
              linkedUserId: personalSharedGroupParticipants.linked_user_id,
              consentedAt: personalSharedGroupParticipants.consented_at,
              revokedAt: personalSharedGroupParticipants.revoked_at,
            })
            .from(personalSharedGroupParticipants)
            .where(
              and(
                eq(personalSharedGroupParticipants.binding_id, challenge.binding_id),
                eq(personalSharedGroupParticipants.platform_user_id, input.actorPlatformUserId),
              ),
            )
            .limit(1)
            .for("update");
          if (!participant) return { status: "actor_not_registered" } as const;
          if (
            participant.revokedAt === null &&
            participant.linkedUserId !== null &&
            participant.consentedAt !== null
          ) {
            return { status: "already_linked" } as const;
          }
          const [accountLink] = await tx
            .select({ id: personalSharedGroupParticipants.id })
            .from(personalSharedGroupParticipants)
            .where(
              and(
                eq(personalSharedGroupParticipants.binding_id, challenge.binding_id),
                eq(personalSharedGroupParticipants.linked_user_id, input.linkedUserId),
              ),
            )
            .limit(1);
          if (accountLink && accountLink.id !== participant.id) {
            return { status: "already_linked" } as const;
          }

          await tx
            .update(personalSharedGroupJoinChallenges)
            .set({
              consumed_at: now,
              consumed_by_source_message_id: input.sourceMessageId ?? null,
            })
            .where(eq(personalSharedGroupJoinChallenges.id, challenge.id));
          if (priorConfirms.length > 0) {
            await tx.delete(personalSharedGroupJoinChallenges).where(
              inArray(
                personalSharedGroupJoinChallenges.id,
                priorConfirms.map(({ id }) => id),
              ),
            );
          }
          await tx.insert(personalSharedGroupJoinChallenges).values({
            code_hash: input.confirmCodeHash,
            stage: "confirm",
            binding_id: challenge.binding_id,
            consent_version: challenge.consent_version,
            platform: challenge.platform,
            project: challenge.project,
            connector_account_id: challenge.connector_account_id,
            provider_chat_id: challenge.provider_chat_id,
            provider_thread_id: challenge.provider_thread_id,
            issued_to_platform_user_id: challenge.issued_to_platform_user_id,
            source_message_id: sourceMessageId,
            linked_user_id: input.linkedUserId,
            expires_at: input.expiresAt,
          });
          return {
            status: "confirm_issued",
            bindingId: challenge.binding_id,
            consentVersion: challenge.consent_version,
          } as const;
        }),
      {},
    );
  }

  async consumeJoinConfirmChallenge(input: {
    codeHash: string;
    sourceMessageId?: string;
    bindingId: string;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    providerThreadId?: string | null;
    actorPlatformUserId: string;
  }): Promise<ConsumePersonalSharedGroupJoinConfirmResult> {
    assertChallengeInput(input);
    if (!input.providerChatId) {
      throw consentInputError("Personal Shared group confirmation destination is incomplete", {
        bindingId: input.bindingId,
      });
    }
    return withConsentStorageBoundary(
      () =>
        waitForAuthorityMutation<ConsumePersonalSharedGroupJoinConfirmResult>(() =>
          this.database.transaction(async (tx) => {
            const now = new Date();
            const sourceMessageId = input.sourceMessageId ?? input.codeHash;
            const [observedChallenge] = await tx
              .select()
              .from(personalSharedGroupJoinChallenges)
              .where(eq(personalSharedGroupJoinChallenges.code_hash, input.codeHash))
              .limit(1);
            if (!observedChallenge || !observedChallenge.linked_user_id) {
              return { blocked: false, result: { status: "invalid" as const } };
            }

            // Lock the account before any binding/challenge/participant row.
            // Lifecycle mutations take the same order and therefore cannot
            // miss a consent link that appears just before deactivation.
            const [linkedUser] = await tx
              .select({
                stewardUserId: users.steward_user_id,
                telegramId: users.telegram_id,
                phoneNumber: users.phone_number,
                phoneVerified: users.phone_verified,
                isAnonymous: users.is_anonymous,
                isActive: users.is_active,
                deletedAt: users.deleted_at,
                organizationId: users.organization_id,
              })
              .from(users)
              .where(eq(users.id, observedChallenge.linked_user_id))
              .limit(1)
              .for("update");
            const activeOrganization = await hasActiveOrganization(tx, linkedUser?.organizationId);

            const [binding] = await tx
              .select({
                id: personalSharedGroupBindings.id,
                consentVersion: personalSharedGroupBindings.consent_version,
                deliveryLeaseBlocked: deliveryLeaseBlocksAuthorityMutation(now),
              })
              .from(personalSharedGroupBindings)
              .where(
                and(
                  eq(personalSharedGroupBindings.id, observedChallenge.binding_id),
                  eq(personalSharedGroupBindings.state, "active"),
                  eq(personalSharedGroupBindings.consent_mode, "all_adults"),
                ),
              )
              .limit(1)
              .for("update");

            const [challenge] = await tx
              .select()
              .from(personalSharedGroupJoinChallenges)
              .where(eq(personalSharedGroupJoinChallenges.id, observedChallenge.id))
              .limit(1)
              .for("update");
            const failure = classifyChallenge(challenge, {
              stage: "confirm",
              now,
              bindingId: input.bindingId,
              platform: input.platform,
              project: input.project,
              connectorAccountId: input.connectorAccountId,
              providerChatId: input.providerChatId,
              providerThreadId: normalizedThreadId(input.providerThreadId),
              actorPlatformUserId: input.actorPlatformUserId,
            });
            if (
              failure === "already_used" &&
              input.sourceMessageId !== undefined &&
              challenge?.consumed_by_source_message_id === sourceMessageId &&
              challenge.stage === "confirm" &&
              challenge.expires_at > now &&
              challenge.binding_id === input.bindingId &&
              challenge.platform === input.platform &&
              challenge.project === input.project &&
              challenge.connector_account_id === input.connectorAccountId &&
              challenge.provider_chat_id === input.providerChatId &&
              challenge.provider_thread_id === normalizedThreadId(input.providerThreadId) &&
              challenge.issued_to_platform_user_id === input.actorPlatformUserId &&
              binding?.consentVersion === challenge.consent_version
            ) {
              const [replayParticipant] = await tx
                .select({
                  linkedUserId: personalSharedGroupParticipants.linked_user_id,
                  consentedAt: personalSharedGroupParticipants.consented_at,
                  revokedAt: personalSharedGroupParticipants.revoked_at,
                })
                .from(personalSharedGroupParticipants)
                .where(
                  and(
                    eq(personalSharedGroupParticipants.binding_id, input.bindingId),
                    eq(personalSharedGroupParticipants.platform_user_id, input.actorPlatformUserId),
                  ),
                )
                .limit(1)
                .for("update");
              const matureReplaySubject =
                linkedUser &&
                !linkedUser.stewardUserId.startsWith("phone:") &&
                !linkedUser.stewardUserId.startsWith("telegram:");
              const replayIdentityMatches =
                linkedUser &&
                (challenge.platform === "blooio"
                  ? linkedUser.phoneNumber === challenge.issued_to_platform_user_id &&
                    linkedUser.phoneVerified === true
                  : linkedUser.telegramId === challenge.issued_to_platform_user_id);
              if (
                replayParticipant?.linkedUserId === challenge.linked_user_id &&
                replayParticipant.consentedAt !== null &&
                replayParticipant.revokedAt === null &&
                linkedUser?.isActive === true &&
                activeOrganization &&
                linkedUser.deletedAt === null &&
                linkedUser.isAnonymous === false &&
                matureReplaySubject &&
                replayIdentityMatches
              ) {
                const consent = await deriveConsentStatusInTransaction(tx, input.bindingId);
                if (consent) {
                  return {
                    blocked: false,
                    result: { status: "consented" as const, consent },
                  };
                }
              }
            }
            if (failure) return { blocked: false, result: { status: failure } };
            if (!challenge) {
              return { blocked: false, result: { status: "invalid" as const } };
            }
            if (!binding || binding.consentVersion !== challenge.consent_version) {
              return { blocked: false, result: { status: "stale" as const } };
            }
            if (binding.deliveryLeaseBlocked) return { blocked: true } as const;

            const [participant] = await tx
              .select({
                id: personalSharedGroupParticipants.id,
                linkedUserId: personalSharedGroupParticipants.linked_user_id,
                consentedAt: personalSharedGroupParticipants.consented_at,
                revokedAt: personalSharedGroupParticipants.revoked_at,
              })
              .from(personalSharedGroupParticipants)
              .where(
                and(
                  eq(personalSharedGroupParticipants.binding_id, input.bindingId),
                  eq(personalSharedGroupParticipants.platform_user_id, input.actorPlatformUserId),
                ),
              )
              .limit(1)
              .for("update");
            if (!participant) {
              return {
                blocked: false,
                result: { status: "actor_not_registered" as const },
              };
            }
            if (
              participant.revokedAt === null &&
              participant.linkedUserId !== null &&
              participant.consentedAt !== null
            ) {
              return { blocked: false, result: { status: "already_linked" as const } };
            }
            const [accountLink] = await tx
              .select({ id: personalSharedGroupParticipants.id })
              .from(personalSharedGroupParticipants)
              .where(
                and(
                  eq(personalSharedGroupParticipants.binding_id, input.bindingId),
                  eq(personalSharedGroupParticipants.linked_user_id, challenge.linked_user_id!),
                ),
              )
              .limit(1);
            if (accountLink && accountLink.id !== participant.id) {
              return { blocked: false, result: { status: "already_linked" as const } };
            }

            // Authentication and confirmation are intentionally separate
            // handoff stages. Revalidate the account under the U-first row lock
            // so an identity downgrade cannot cross the consent boundary.
            const matureSubject =
              linkedUser &&
              !linkedUser.stewardUserId.startsWith("phone:") &&
              !linkedUser.stewardUserId.startsWith("telegram:");
            const providerIdentityMatches =
              linkedUser &&
              (challenge.platform === "blooio"
                ? linkedUser.phoneNumber === challenge.issued_to_platform_user_id &&
                  linkedUser.phoneVerified === true
                : linkedUser.telegramId === challenge.issued_to_platform_user_id);
            if (
              !linkedUser ||
              !activeOrganization ||
              !linkedUser.isActive ||
              linkedUser.deletedAt !== null ||
              linkedUser.isAnonymous ||
              !matureSubject ||
              !providerIdentityMatches
            ) {
              return {
                blocked: false,
                result: { status: "account_not_authenticated" as const },
              };
            }

            const [authority] = await tx
              .update(personalSharedGroupBindings)
              .set({
                authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
                updated_at: now,
              })
              .where(
                and(
                  eq(personalSharedGroupBindings.id, input.bindingId),
                  eq(personalSharedGroupBindings.consent_version, challenge.consent_version),
                  deliveryLeaseAllowsAuthorityMutation(now),
                ),
              )
              .returning({ id: personalSharedGroupBindings.id });
            if (!authority) return { blocked: true } as const;
            await tx
              .update(personalSharedGroupParticipants)
              .set({
                linked_user_id: challenge.linked_user_id,
                consented_at: now,
                consent_provenance: "authenticated_dm",
                revoked_at: null,
                last_seen_at: now,
              })
              .where(eq(personalSharedGroupParticipants.id, participant.id));
            await tx
              .update(personalSharedGroupJoinChallenges)
              .set({
                consumed_at: now,
                consumed_by_source_message_id: input.sourceMessageId ?? null,
              })
              .where(
                and(
                  eq(personalSharedGroupJoinChallenges.id, challenge.id),
                  isNull(personalSharedGroupJoinChallenges.consumed_at),
                ),
              );
            const consent = await deriveConsentStatusInTransaction(tx, input.bindingId);
            if (!consent) {
              throw new ElizaError("Consent status vanished during join confirmation", {
                code: "PERSONAL_SHARED_GROUP_CONSENT_STATUS_MISSING",
                severity: "fatal",
                context: { bindingId: input.bindingId },
              });
            }
            return { blocked: false, result: { status: "consented" as const, consent } };
          }),
        ),
      { bindingId: input.bindingId },
    );
  }

  async deriveConsentStatus(input: {
    bindingId: string;
  }): Promise<PersonalSharedGroupConsentStatus | null> {
    if (!input.bindingId) {
      throw consentInputError("Personal Shared group consent status binding is missing", {});
    }
    return withConsentStorageBoundary(
      () =>
        this.database.transaction((tx) => deriveConsentStatusInTransaction(tx, input.bindingId)),
      { bindingId: input.bindingId },
    );
  }

  async selfRevoke(input: {
    bindingId: string;
    actorPlatformUserId: string;
  }): Promise<PersonalSharedGroupSelfRevokeResult> {
    if (!input.bindingId || !input.actorPlatformUserId) {
      throw consentInputError("Personal Shared group self-revocation identity is incomplete", {
        bindingId: input.bindingId,
      });
    }
    return withConsentStorageBoundary(
      () =>
        waitForAuthorityMutation<PersonalSharedGroupSelfRevokeResult>(() =>
          this.database.transaction(async (tx) => {
            const now = new Date();
            const [binding] = await tx
              .select({
                id: personalSharedGroupBindings.id,
                ownerUserId: personalSharedGroupBindings.owner_user_id,
                deliveryLeaseBlocked: deliveryLeaseBlocksAuthorityMutation(now),
              })
              .from(personalSharedGroupBindings)
              .where(
                and(
                  eq(personalSharedGroupBindings.id, input.bindingId),
                  eq(personalSharedGroupBindings.state, "active"),
                  eq(personalSharedGroupBindings.consent_mode, "all_adults"),
                ),
              )
              .limit(1)
              .for("update");
            if (!binding) {
              return { blocked: false, result: { status: "invalid" as const } };
            }
            const [participant] = await tx
              .select({
                id: personalSharedGroupParticipants.id,
                linkedUserId: personalSharedGroupParticipants.linked_user_id,
                consentedAt: personalSharedGroupParticipants.consented_at,
                revokedAt: personalSharedGroupParticipants.revoked_at,
              })
              .from(personalSharedGroupParticipants)
              .where(
                and(
                  eq(personalSharedGroupParticipants.binding_id, input.bindingId),
                  eq(personalSharedGroupParticipants.platform_user_id, input.actorPlatformUserId),
                ),
              )
              .limit(1)
              .for("update");
            if (
              !participant ||
              participant.linkedUserId === null ||
              participant.consentedAt === null ||
              participant.revokedAt !== null
            ) {
              return { blocked: false, result: { status: "not_linked" as const } };
            }
            if (participant.linkedUserId === binding.ownerUserId) {
              return { blocked: false, result: { status: "owner_forbidden" as const } };
            }
            if (binding.deliveryLeaseBlocked) return { blocked: true } as const;

            const [authority] = await tx
              .update(personalSharedGroupBindings)
              .set({
                authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
                consent_version: sql`${personalSharedGroupBindings.consent_version} + 1`,
                updated_at: now,
              })
              .where(
                and(
                  eq(personalSharedGroupBindings.id, input.bindingId),
                  deliveryLeaseAllowsAuthorityMutation(now),
                ),
              )
              .returning({ id: personalSharedGroupBindings.id });
            if (!authority) return { blocked: true } as const;
            await tx
              .update(personalSharedGroupParticipants)
              .set({
                linked_user_id: null,
                consented_at: null,
                consent_provenance: null,
                revoked_at: now,
              })
              .where(eq(personalSharedGroupParticipants.id, participant.id));
            const consent = await deriveConsentStatusInTransaction(tx, input.bindingId);
            if (!consent) {
              throw new ElizaError("Consent status vanished during self-revocation", {
                code: "PERSONAL_SHARED_GROUP_CONSENT_STATUS_MISSING",
                severity: "fatal",
                context: { bindingId: input.bindingId },
              });
            }
            return { blocked: false, result: { status: "revoked" as const, consent } };
          }),
        ),
      { bindingId: input.bindingId },
    );
  }
}

export const personalSharedGroupConsentRepository = new PersonalSharedGroupConsentRepository(
  dbWrite,
);
