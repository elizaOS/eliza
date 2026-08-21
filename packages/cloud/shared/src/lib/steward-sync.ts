/**
 * Steward User Synchronization
 *
 * Resolves a Steward JWT to an eliza-cloud user.
 *
 * 1. Steward JWTs contain email/userId/walletAddress directly (no third-party API call)
 * 2. No anonymous user upgrade path (Steward doesn't have anonymous users)
 * 3. Uses steward_user_id as the canonical external auth identity
 *
 * A claimed wallet address is canonicalized with `normalizeWallet` — the same
 * rule as the wallet blind index — so an address matches the row that already
 * holds it whichever surface wrote that row first. It is chain-shaped on
 * purpose: EVM hex folds case, base58 does not, because two Solana keys can
 * differ only in case.
 */

import { ElizaError, isElizaError } from "@elizaos/core";
import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";
import { normalizeWallet } from "../db/crypto/field-crypto";
import { organizationInvitesRepository } from "../db/repositories/organization-invites";
import {
  type CommitPhoneTelegramConvergenceResult,
  usersRepository,
} from "../db/repositories/users";
import type { RuntimeDurableObjectNamespace } from "../types/cloud-worker-env";
import { apiKeysService } from "./services/api-keys";
import { charactersService } from "./services/characters/characters";
import { discordService } from "./services/discord";
import { invalidateBoundPersonalDeliveryProjection } from "./services/eliza-app/personal-delivery-projection-contract";
import { emailService } from "./services/email";
import { invitesService } from "./services/invites";
import { organizationsService } from "./services/organizations";
import {
  commitPersonalProvisionalHistoryConvergence,
  type PersonalProvisionalHistoryConvergence,
  type PreparedPersonalProvisionalHistoryConvergence,
  preparePersonalProvisionalHistoryConvergence,
  releasePersonalProvisionalHistoryConvergence,
} from "./services/shared-runtime/conversation-coordinator";
import { personalSharedAgentId } from "./services/shared-runtime/personal-shared-agent";
import type { SignupGrantWithheldReason } from "./services/signup-grant-guard";
import { ensureStewardTenant } from "./services/steward-tenant-config";
import { usersService } from "./services/users";
import { SIGNUP_CREDIT_POLICY } from "./signup-credits";
import type { UserWithOrganization } from "./types";
import { getDefaultElizaCharacterData } from "./utils/default-eliza-character";
import { getRandomUserAvatar } from "./utils/default-user-avatar";
import { logger } from "./utils/logger";
import { isValidE164, normalizePhoneNumber } from "./utils/phone-normalization";

export interface SignupWelcomeBonusMetadata {
  initialCreditsGranted?: boolean;
  initialFreeCreditsUsd?: number;
  welcomeBonusWithheld?: boolean;
  welcomeBonusWithheldReason?: SignupGrantWithheldReason;
  welcomeBonusWithheldMessage?: string;
}

export type StewardSyncedUser = UserWithOrganization & SignupWelcomeBonusMetadata;

const STEWARD_IDENTITY_UNIQUE_CONSTRAINT = "user_identities_steward_user_id_unique";

function extractErrorMetadata(candidate: unknown): {
  code?: string;
  constraint?: string;
  detail?: string;
  message: string;
} {
  if (!candidate || typeof candidate !== "object") {
    return { message: String(candidate ?? "") };
  }

  const typedCandidate = candidate as {
    code?: unknown;
    constraint?: unknown;
    detail?: unknown;
    message?: unknown;
  };

  return {
    code: typeof typedCandidate.code === "string" ? typedCandidate.code : undefined,
    constraint:
      typeof typedCandidate.constraint === "string" ? typedCandidate.constraint : undefined,
    detail: typeof typedCandidate.detail === "string" ? typedCandidate.detail : undefined,
    message:
      typeof typedCandidate.message === "string" ? typedCandidate.message : String(candidate),
  };
}

/** True for a Postgres unique-constraint violation (23505), directly or via `cause`. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (extractErrorMetadata(error).code === "23505") return true;
  return "cause" in error && extractErrorMetadata(error.cause).code === "23505";
}

/**
 * One-line description of a sync failure with the Postgres fields
 * (code/constraint/detail) inlined, falling through to `cause` for wrapped
 * driver errors. Workers Logs only indexes the message STRING — an Error
 * passed in a logger context object is dropped entirely — so callers must
 * interpolate this into the log message itself, never attach it as metadata.
 */
export function describeSyncError(error: unknown): string {
  const meta = extractErrorMetadata(error);
  const causeMeta =
    error && typeof error === "object" && "cause" in error
      ? extractErrorMetadata(error.cause)
      : { code: undefined, constraint: undefined, detail: undefined, message: "" };
  const code = meta.code ?? causeMeta.code;
  const constraint = meta.constraint ?? causeMeta.constraint;
  const detail = meta.detail ?? causeMeta.detail;
  const parts = [meta.message || causeMeta.message || String(error)];
  if (code) parts.push(`code=${code}`);
  if (constraint) parts.push(`constraint=${constraint}`);
  if (detail) parts.push(`detail=${detail}`);
  if (!code && error instanceof Error && error.stack) {
    parts.push(`stack=${error.stack.split("\n").slice(0, 4).join(" | ")}`);
  }
  return parts.join(" ");
}

function isRecoverableStewardProjectionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const errorMetadata = extractErrorMetadata(error);
  const causeMetadata = "cause" in error ? extractErrorMetadata(error.cause) : { message: "" };
  const isUniqueViolation = errorMetadata.code === "23505" || causeMetadata.code === "23505";
  const hasExactStewardConstraint =
    errorMetadata.constraint === STEWARD_IDENTITY_UNIQUE_CONSTRAINT ||
    causeMetadata.constraint === STEWARD_IDENTITY_UNIQUE_CONSTRAINT;

  return isUniqueViolation && hasExactStewardConstraint;
}

async function recoverCanonicalStewardUser(
  expectedUserId: string,
  stewardUserId: string,
  context: "invite" | "signup",
  error: unknown,
): Promise<boolean> {
  if (!isRecoverableStewardProjectionConflict(error)) {
    return false;
  }

  const projection = await usersService.getStewardIdentityForWrite(stewardUserId);
  if (!projection || projection.user_id !== expectedUserId) {
    return false;
  }

  const user = await usersService.getByStewardIdForWrite(stewardUserId);
  if (!user || user.id !== expectedUserId) {
    return false;
  }

  logger.warn("[StewardSync] Recovered from stale Steward identity projection conflict", {
    context,
    expectedUserId,
    stewardUserId,
    error: error instanceof Error ? error.message : String(error),
  });

  return true;
}

async function rollbackCreatedUserSafely(
  userId: string,
  context: "invite" | "signup",
  originalError: unknown,
): Promise<void> {
  try {
    await usersRepository.delete(userId);
  } catch (rollbackError) {
    logger.error("[StewardSync] Failed to roll back newly created user", {
      context,
      userId,
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    });
  }
}

async function restorePreviousStewardUserIdSafely(
  userId: string,
  previousStewardUserId: string,
  originalError: unknown,
): Promise<void> {
  try {
    await usersService.update(userId, {
      steward_user_id: previousStewardUserId,
      updated_at: new Date(),
    });
  } catch (rollbackError) {
    logger.error("[StewardSync] Failed to restore previous Steward user ID", {
      userId,
      previousStewardUserId,
      originalError: originalError instanceof Error ? originalError.message : String(originalError),
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    });
  }
}

/**
 * Generates a unique organization slug from an email address.
 */
function generateSlugFromEmail(email: string): string {
  const username = email.split("@")[0];
  const sanitized = username.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `${sanitized}-${timestamp}${random}`;
}

/**
 * Generates a unique organization slug from a wallet address.
 */
function generateSlugFromWallet(walletAddress: string): string {
  const shortAddress = walletAddress.substring(0, 8);
  const sanitized = shortAddress.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `wallet-${sanitized}-${timestamp}${random}`;
}

function generateSlugFromName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `${sanitized}-${timestamp}${random}`;
}

export interface StewardSyncParams {
  stewardUserId: string;
  email?: string;
  walletAddress?: string;
  walletChainType?: "ethereum" | "solana";
  name?: string;
  /** Phone independently verified against the current Steward bearer. */
  verifiedPhone?: string;
  /** Stable Telegram id carried by the server-verified Steward JWT. */
  verifiedTelegramId?: string;
  /** Opaque account-bound continuation delivered only inside a Telegram DM. */
  telegramContinuation?: string;
  /** Strongly ordered personal-history coordinator supplied by the Worker auth boundary. */
  sharedRuntimeConversationNamespace?: RuntimeDurableObjectNamespace;
}

export class StewardPhoneAccountConflictError extends Error {
  override readonly name = "StewardPhoneAccountConflictError";

  constructor(readonly reason: string) {
    super(`Verified phone account could not be claimed: ${reason}`);
  }
}

export class StewardTelegramAccountClaimError extends ElizaError {
  override readonly name = "StewardTelegramAccountClaimError";

  constructor(readonly reason: string) {
    super(`Telegram personal account could not be claimed: ${reason}`, {
      code: "STEWARD_TELEGRAM_ACCOUNT_CLAIM_CONFLICT",
      context: { reason },
      severity: "ephemeral",
    });
  }
}

const PROVISIONAL_CONVERGENCE_LEASE_MS = 5 * 60 * 1000;

function historyConvergencePlan(input: {
  token: string;
  sourceAgentId: string;
  targetAgentId: string;
  targetUserId: string;
  targetOrganizationId: string;
}): PersonalProvisionalHistoryConvergence {
  return {
    token: input.token,
    holderId: crypto.randomUUID(),
    sourceAgentId: input.sourceAgentId,
    targetAgentId: input.targetAgentId,
    targetUserId: input.targetUserId,
    targetOrganizationId: input.targetOrganizationId,
    leaseMs: PROVISIONAL_CONVERGENCE_LEASE_MS,
  };
}

type CommittedPhoneTelegramConvergence = Extract<
  CommitPhoneTelegramConvergenceResult,
  { status: "committed" | "already_committed" }
>;

async function completePhoneTelegramHistoryConvergence(input: {
  convergence: Pick<CommittedPhoneTelegramConvergence, "receipt" | "user" | "organization">;
  namespace?: RuntimeDurableObjectNamespace;
  prepared?: {
    plan: PersonalProvisionalHistoryConvergence;
    snapshot: PreparedPersonalProvisionalHistoryConvergence;
  };
}): Promise<UserWithOrganization> {
  if (!input.namespace) {
    throw new StewardPhoneAccountConflictError("history_coordinator_unavailable");
  }

  const { receipt, user, organization } = input.convergence;
  const expectedSourceAgentId = personalSharedAgentId({
    userId: receipt.source_user_id,
    organizationId: receipt.source_organization_id,
  });
  const expectedTargetAgentId = personalSharedAgentId({
    userId: receipt.target_user_id,
    organizationId: receipt.target_organization_id,
  });
  if (
    receipt.source_agent_id !== expectedSourceAgentId ||
    receipt.target_agent_id !== expectedTargetAgentId ||
    receipt.target_user_id !== user.id ||
    receipt.target_organization_id !== organization.id ||
    user.organization_id !== organization.id ||
    user.steward_user_id !== receipt.steward_user_id ||
    user.phone_number !== receipt.phone_number ||
    user.phone_verified !== true ||
    user.telegram_id !== receipt.telegram_id
  ) {
    throw new StewardTelegramAccountClaimError("identity_projection_conflict");
  }

  const plan =
    input.prepared?.plan ??
    historyConvergencePlan({
      token: receipt.token,
      sourceAgentId: receipt.source_agent_id,
      targetAgentId: receipt.target_agent_id,
      targetUserId: receipt.target_user_id,
      targetOrganizationId: receipt.target_organization_id,
    });
  const snapshot =
    input.prepared?.snapshot ??
    (await preparePersonalProvisionalHistoryConvergence(plan, {
      namespace: input.namespace,
    }));
  await commitPersonalProvisionalHistoryConvergence(plan, snapshot, {
    namespace: input.namespace,
  });
  const completed = await usersRepository.markPhoneTelegramPersonalAccountAliasComplete(
    receipt.token,
  );
  if (!completed) {
    throw new Error("Personal account convergence receipt disappeared during recovery");
  }

  return { ...user, organization };
}

type ConvergenceConflictStatus = Exclude<
  CommitPhoneTelegramConvergenceResult["status"],
  "committed" | "already_committed"
>;

function throwConvergenceConflict(status: ConvergenceConflictStatus): never {
  if (
    status === "phone_account_mature" ||
    status === "funded_account" ||
    status === "agent_bearing_account"
  ) {
    throw new StewardPhoneAccountConflictError(status);
  }
  throw new StewardTelegramAccountClaimError(status);
}

async function linkVerifiedPhoneForStewardSync(userId: string, phoneNumber: string): Promise<void> {
  try {
    const linked = await usersRepository.linkVerifiedPhone(userId, phoneNumber);
    if (!linked) {
      throw new StewardPhoneAccountConflictError("phone_link_user_not_found");
    }
  } catch (error) {
    // error-policy:J1 Verified-phone ownership conflicts are an explicit auth
    // boundary result; other repository failures retain their original cause.
    if (isUniqueViolation(error)) {
      throw new StewardPhoneAccountConflictError("verified_phone_unique_conflict");
    }
    if (extractErrorMetadata(error).code === "VERIFIED_PHONE_MISMATCH") {
      throw new StewardPhoneAccountConflictError("verified_phone_mismatch");
    }
    throw error;
  }
  await invalidateBoundPersonalDeliveryProjection("phone", phoneNumber);
}

/**
 * Finds the row that already holds this wallet, matching the way the address was
 * STORED.
 *
 * `usersRepository.findByWalletAddress*` lowercases its predicate, which is
 * right for EVM hex and wrong for base58: a Solana row written by
 * `/api/auth/siws/verify` keeps the case-sensitive key verbatim, so the folded
 * lookup cannot see it, step 4 falls through to step 5, and the same human ends
 * up with a second Cloud account — a second wallet identity at every relying
 * party keyed on it. The discriminator is `normalizeWallet`'s: a `0x` address is
 * EVM hex, anything else is base58.
 */
async function findUserByStoredWalletAddress(
  walletAddress: string,
): Promise<UserWithOrganization | undefined> {
  return walletAddress.startsWith("0x")
    ? await usersService.getByWalletAddressWithOrganization(walletAddress)
    : await usersRepository.findBySolanaWalletAddressWithOrganization(walletAddress);
}

/**
 * Sync a Steward user to the local database.
 * Creates user and organization if they don't exist.
 * Updates user data if it has changed.
 *
 * Flow:
 * 1. Check if user exists by steward_user_id -> return existing (update if needed)
 * 2. Check for pending invite by email -> accept invite, create user in that org
 * 3. Check if email already taken -> link steward_user_id to existing account
 * 4. Check for wallet-only Steward session -> link to existing wallet user if possible
 * 5. Create new user + organization
 */
async function syncUserFromStewardBase(params: StewardSyncParams): Promise<StewardSyncedUser> {
  const { stewardUserId, walletChainType } = params;
  const email = params.email?.toLowerCase().trim();
  const verifiedPhone = params.verifiedPhone
    ? normalizePhoneNumber(params.verifiedPhone)
    : undefined;
  if (verifiedPhone && !isValidE164(verifiedPhone)) {
    throw new StewardPhoneAccountConflictError("invalid_phone");
  }
  // Chain-aware, NOT a blanket lowercase: folding a base58 key produces a string
  // that is not the user's wallet, matches no existing row, and is then stored
  // as if it were a second wallet.
  const walletAddress = params.walletAddress
    ? normalizeWallet(params.walletAddress, walletChainType)
    : undefined;
  const resolvedWalletChainType = walletAddress ? (walletChainType ?? "ethereum") : walletChainType;

  // Resolve display name with fallbacks
  let name = params.name;
  if (!name && email) {
    name = email.split("@")[0];
  } else if (!name && walletAddress) {
    name = `${walletAddress.substring(0, 6)}...${walletAddress.substring(walletAddress.length - 4)}`;
  } else if (!name && verifiedPhone) {
    name = `User ***${verifiedPhone.slice(-4)}`;
  } else if (!name) {
    name = `user-${stewardUserId.substring(0, 8)}`;
  }

  let claimedTelegramUser: UserWithOrganization | undefined;

  // Once the database merge commits, the authenticated Steward subject is the
  // durable retry authority. A repeated phone claim narrows that authority but
  // is not required, and a stale one-time continuation cannot strand repair.
  const pending = await usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
    stewardUserId,
    ...(verifiedPhone ? { phoneNumber: verifiedPhone } : {}),
  });
  if (pending.status === "identity_projection_conflict") {
    throw new StewardTelegramAccountClaimError(pending.status);
  }
  if (pending.status === "resume_alias") {
    claimedTelegramUser = await completePhoneTelegramHistoryConvergence({
      convergence: pending,
      namespace: params.sharedRuntimeConversationNamespace,
    });
  }

  // A Telegram DM creates the canonical rowless account before a browser
  // session exists. The opaque, account-bound continuation is validated first,
  // then the provisional `telegram:<id>` subject is atomically promoted before
  // generic Steward sync has any opportunity to create a duplicate user/org.
  if (params.telegramContinuation && !claimedTelegramUser) {
    let claim: Awaited<
      ReturnType<
        typeof import("./services/eliza-app/onboarding-chat").inspectTelegramPersonalAccountContinuation
      >
    >;
    try {
      const { inspectTelegramPersonalAccountContinuation } = await import(
        "./services/eliza-app/onboarding-chat"
      );
      claim = await inspectTelegramPersonalAccountContinuation(params.telegramContinuation);
    } catch (error) {
      // error-policy:J3 Invalid opaque authority becomes one non-enumerating
      // claim conflict; storage and coordinator failures still surface as 5xx.
      if (!isElizaError(error) || error.code !== "ONBOARDING_TRUSTED_CONTINUATION_INVALID") {
        throw error;
      }
      logger.warn("[StewardSync] Telegram continuation validation failed", {
        stewardUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new StewardTelegramAccountClaimError("invalid_continuation");
    }

    if (verifiedPhone) {
      const proof = {
        phoneNumber: verifiedPhone,
        telegramId: claim.telegramId,
        stewardUserId,
        expectedTelegramUserId: claim.userId,
        expectedTelegramOrganizationId: claim.organizationId,
      };
      const inspection =
        await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proof);

      if (inspection.status === "eligible") {
        const namespace = params.sharedRuntimeConversationNamespace;
        if (!namespace) {
          throw new StewardPhoneAccountConflictError("history_coordinator_unavailable");
        }
        const sourceAgentId = personalSharedAgentId({
          userId: inspection.plan.sourceUser.id,
          organizationId: inspection.plan.sourceOrganization.id,
        });
        const targetAgentId = personalSharedAgentId({
          userId: inspection.plan.targetUser.id,
          organizationId: inspection.plan.targetOrganization.id,
        });
        const token = `phone-telegram:${inspection.plan.sourceUser.id}:${inspection.plan.targetUser.id}`;
        const historyPlan = historyConvergencePlan({
          token,
          sourceAgentId,
          targetAgentId,
          targetUserId: inspection.plan.targetUser.id,
          targetOrganizationId: inspection.plan.targetOrganization.id,
        });
        const preparedHistory = await preparePersonalProvisionalHistoryConvergence(historyPlan, {
          namespace,
        });

        let databaseCommitted = false;
        try {
          const convergence = await usersRepository.commitPhoneTelegramPersonalAccountConvergence({
            ...proof,
            sourceUserId: inspection.plan.sourceUser.id,
            sourceOrganizationId: inspection.plan.sourceOrganization.id,
            sourceAgentId,
            targetUserId: inspection.plan.targetUser.id,
            targetOrganizationId: inspection.plan.targetOrganization.id,
            targetAgentId,
            token,
          });
          if (convergence.status !== "committed" && convergence.status !== "already_committed") {
            throwConvergenceConflict(convergence.status);
          }
          databaseCommitted = true;
          claimedTelegramUser = await completePhoneTelegramHistoryConvergence({
            convergence,
            namespace,
            prepared: { plan: historyPlan, snapshot: preparedHistory },
          });
        } catch (error) {
          // error-policy:J6 pre-commit rejection releases only this attempt's
          // history holder; post-commit failures retain both leases for recovery.
          if (!databaseCommitted) {
            try {
              await releasePersonalProvisionalHistoryConvergence(historyPlan, { namespace });
            } catch (releaseError) {
              // error-policy:J6 the database rejection remains primary; the
              // bounded leases self-expire and this makes delayed repair visible.
              logger.warn("[StewardSync] Failed to release rejected convergence leases", {
                sourceAgentId,
                error: releaseError instanceof Error ? releaseError.message : String(releaseError),
              });
            }
          }
          throw error;
        }
      } else if (inspection.status === "resume_alias") {
        claimedTelegramUser = await completePhoneTelegramHistoryConvergence({
          convergence: inspection,
          namespace: params.sharedRuntimeConversationNamespace,
        });
      } else if (inspection.status !== "not_dual_account") {
        throwConvergenceConflict(inspection.status);
      }
    }

    if (!claimedTelegramUser) {
      const promotion = await usersRepository.promoteTelegramPersonalAccountToSteward({
        telegramId: claim.telegramId,
        stewardUserId,
        expectedUserId: claim.userId,
        expectedOrganizationId: claim.organizationId,
      });
      if (promotion.status !== "promoted" && promotion.status !== "already_promoted") {
        throw new StewardTelegramAccountClaimError(promotion.status);
      }
      claimedTelegramUser = {
        ...promotion.user,
        organization: promotion.organization,
      };
    }
  }

  if (claimedTelegramUser?.telegram_id) {
    await invalidateBoundPersonalDeliveryProjection("telegram", claimedTelegramUser.telegram_id);
  }

  // ── 1. Existing user by steward_user_id ──────────────────────────────
  // The canonical subject is resolved before phone-account promotion:
  // promotion claims only a synthetic `phone:<E.164>` account for a subject
  // with no canonical row, so attempting it for an established user would
  // misread the subject's own account as `steward_subject_owned_by_other_user`
  // and 409 the first verified-phone session (#19365). An existing user links
  // the unowned verified phone through the existing-user path below instead.
  let user = claimedTelegramUser ?? (await usersService.getByStewardId(stewardUserId));

  // A signed inbound text creates a phone-only personal account before any
  // browser session exists. SMS login may claim only that exact synthetic
  // account. Stable user/org ids keep its Shared history attached.
  if (verifiedPhone && !user) {
    const promotion = await usersRepository.promotePhonePersonalAccountToSteward({
      phoneNumber: verifiedPhone,
      stewardUserId,
    });
    if (promotion.status === "promoted" || promotion.status === "already_promoted") {
      const promotedUser: UserWithOrganization = {
        ...promotion.user,
        organization: promotion.organization,
      };
      await apiKeysService.provisionDefaultApiKey(promotedUser.id, promotion.organization.id);
      await ensureDefaultCharacter(promotedUser.id, promotion.organization.id);
      try {
        await ensureStewardTenant(promotion.organization.id);
      } catch (error) {
        // error-policy:J4 tenant provisioning is an opportunistic repair; the
        // claimed account and Shared history remain usable and retry next login.
        logger.warn(
          `[StewardSync] Phone-account tenant provisioning failed for org ${promotion.organization.id}; sign-in proceeds: ${describeSyncError(error)}`,
        );
      }
      await invalidateBoundPersonalDeliveryProjection("phone", verifiedPhone);
      return promotedUser;
    }
    if (promotion.status !== "not_found") {
      throw new StewardPhoneAccountConflictError(promotion.status);
    }
  }

  if (user) {
    // Telegram promotion updates canonical and projected ownership in one
    // transaction. Ordinary existing accounts retain the repair pass because
    // older sync paths may have written only the canonical column.
    if (!claimedTelegramUser) {
      try {
        await usersService.upsertStewardIdentity(user.id, stewardUserId);
      } catch (error) {
        logger.warn(
          "[StewardSync] Failed to repair Steward identity projection for existing user",
          {
            userId: user.id,
            stewardUserId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    if (verifiedPhone) {
      await linkVerifiedPhoneForStewardSync(user.id, verifiedPhone);
      const phoneLinkedUser = await usersService.getByStewardIdForWrite(stewardUserId);
      if (!phoneLinkedUser) {
        throw new StewardPhoneAccountConflictError("phone_link_user_not_found");
      }
      user = phoneLinkedUser;
    }

    // Update user fields if anything changed
    const shouldUpdate =
      user.name !== name ||
      user.email !== email ||
      user.wallet_address !== walletAddress ||
      (email && !user.email_verified) ||
      (walletAddress && !user.wallet_verified);

    if (shouldUpdate) {
      try {
        await usersService.update(user.id, {
          name,
          email: email || user.email,
          email_verified: !!email || user.email_verified,
          wallet_address: walletAddress || user.wallet_address,
          wallet_chain_type: resolvedWalletChainType || user.wallet_chain_type,
          wallet_verified: walletAddress ? true : user.wallet_verified,
          updated_at: new Date(),
        });

        // Re-read from primary to avoid replica lag
        user = (await usersService.getByStewardIdForWrite(stewardUserId))!;
      } catch (error) {
        // This refresh writes claims-derived email/wallet_address into UNIQUE
        // columns. When another row already owns the value, the same user
        // 23505s on EVERY login — but they are already identified by
        // steward_user_id, so the conflict must not fail the whole sign-in:
        // keep the stored profile and log the collision loudly instead.
        // Anything other than a unique violation still aborts the sync.
        if (!isUniqueViolation(error)) {
          logger.error(
            `[StewardSync] Existing-user profile refresh failed for user ${user.id}: ${describeSyncError(error)}`,
          );
          throw error;
        }
        logger.error(
          `[StewardSync] Existing-user profile refresh conflicts with another row for user ${user.id} — continuing sign-in with the stored profile: ${describeSyncError(error)}`,
        );
      }
    }

    // Self-heal missing Steward tenants on sign-in for orgs created before
    // #14869's eager new-signup provisioning. `ensureStewardTenant` reads the
    // org first and returns immediately when a tenant already exists, so the
    // healthy-org cost is one indexed read while existing NULL-tenant orgs get
    // repaired opportunistically without a bulk backfill.
    if (user.organization_id && !claimedTelegramUser) {
      try {
        await ensureStewardTenant(user.organization_id);
      } catch (error) {
        // error-policy:J4 tenant provisioning is an opportunistic repair, not
        // an auth precondition; keep sign-in fail-open and leave an observable
        // warning so Steward outages do not block returning users.
        logger.warn(
          `[StewardSync] Sign-in tenant self-heal failed for org ${user.organization_id}; sign-in proceeds and the next attempt retries: ${describeSyncError(error)}`,
        );
      }
    }

    return user;
  }

  // ── 2. Pending invite by email ───────────────────────────────────────
  if (email) {
    const pendingInvite = await invitesService.findPendingInviteByEmail(email);

    if (pendingInvite) {
      let newUser: Awaited<ReturnType<typeof usersService.create>> | undefined;

      try {
        newUser = await usersService.create({
          steward_user_id: stewardUserId,
          email: email || null,
          email_verified: !!email,
          wallet_address: walletAddress || null,
          wallet_chain_type: resolvedWalletChainType || null,
          wallet_verified: Boolean(walletAddress),
          phone_number: verifiedPhone || null,
          phone_verified: Boolean(verifiedPhone),
          name,
          avatar: getRandomUserAvatar(),
          organization_id: pendingInvite.organization_id,
          role: pendingInvite.invited_role,
          is_active: true,
        });
        await usersService.upsertStewardIdentity(newUser.id, stewardUserId);
      } catch (error) {
        const recovered =
          newUser &&
          (await recoverCanonicalStewardUser(newUser.id, stewardUserId, "invite", error));

        if (newUser && !recovered) {
          await rollbackCreatedUserSafely(newUser.id, "invite", error);
        }
        if (!recovered) {
          logger.error(
            `[StewardSync] Invited-user creation failed for ${stewardUserId}: ${describeSyncError(error)}`,
          );
          throw error;
        }
      }

      const userWithOrg = await usersService.getByStewardIdForWrite(stewardUserId);

      if (!userWithOrg) {
        throw new Error(
          `Failed to fetch newly created user (steward: ${stewardUserId}) after accepting invite`,
        );
      }

      await organizationInvitesRepository.markAsAccepted(pendingInvite.id, userWithOrg.id);

      // Log to Discord (fire-and-forget)
      discordService
        .logUserSignup({
          userId: userWithOrg.id,
          stewardUserId: userWithOrg.steward_user_id || "",
          email: userWithOrg.email || null,
          name: userWithOrg.name || null,
          walletAddress: userWithOrg.wallet_address || null,
          organizationId: userWithOrg.organization?.id || "",
          organizationName: userWithOrg.organization?.name || "",
          role: userWithOrg.role,
          isNewOrganization: false,
        })
        .catch((error) => {
          logger.error("[StewardSync] Discord log failed:", { error });
        });

      // Same personal default-key mint as the direct-signup branch below —
      // without it an invited user cannot use inference until manually keyed.
      // Awaited for the same Workers-cancellation reason (see the note above
      // the branch-5 provisioning).
      await apiKeysService.provisionDefaultApiKey(
        userWithOrg.id,
        userWithOrg.organization?.id || "",
      );

      return userWithOrg;
    }
  }

  // ── 3. Email already taken (account linking) ─────────────────────────
  if (email) {
    const existingByEmail = await usersService.getByEmailWithOrganization(email);

    if (existingByEmail && existingByEmail.steward_user_id !== stewardUserId) {
      logger.info(
        `[StewardSync] Linking Steward account for ${email}: ${existingByEmail.steward_user_id} → ${stewardUserId}`,
      );
      const previousStewardUserId = existingByEmail.steward_user_id;

      if (verifiedPhone) {
        await linkVerifiedPhoneForStewardSync(existingByEmail.id, verifiedPhone);
      }

      await usersService.update(existingByEmail.id, {
        steward_user_id: stewardUserId,
        updated_at: new Date(),
      });

      try {
        await usersService.upsertStewardIdentity(existingByEmail.id, stewardUserId);
      } catch (error) {
        await restorePreviousStewardUserIdSafely(existingByEmail.id, previousStewardUserId, error);
        logger.error(
          `[StewardSync] Identity projection upsert failed while email-linking user ${existingByEmail.id}: ${describeSyncError(error)}`,
        );
        throw error;
      }

      const linkedUser = await usersService.getByStewardIdForWrite(stewardUserId);
      if (!linkedUser) {
        throw new Error(`Failed to fetch user after Steward account linking for ${email}`);
      }
      return linkedUser;
    }
  }

  // ── 4. Wallet-only Steward session (SIWE or SIWS) ────────────────────
  if (walletAddress && !email) {
    const existingByWallet = await findUserByStoredWalletAddress(walletAddress);

    if (existingByWallet && existingByWallet.steward_user_id !== stewardUserId) {
      logger.info(
        `[StewardSync] Linking Steward wallet account for ${walletAddress}: ${existingByWallet.steward_user_id} → ${stewardUserId}`,
      );

      if (verifiedPhone) {
        await linkVerifiedPhoneForStewardSync(existingByWallet.id, verifiedPhone);
      }

      await usersService.linkStewardId(existingByWallet.id, stewardUserId);

      if (
        !existingByWallet.wallet_verified ||
        existingByWallet.wallet_chain_type !== resolvedWalletChainType
      ) {
        await usersService.update(existingByWallet.id, {
          wallet_verified: true,
          wallet_chain_type: resolvedWalletChainType || existingByWallet.wallet_chain_type,
        });
      }

      try {
        await usersService.upsertStewardIdentity(existingByWallet.id, stewardUserId);
      } catch (error) {
        await restorePreviousStewardUserIdSafely(
          existingByWallet.id,
          existingByWallet.steward_user_id,
          error,
        );
        logger.error(
          `[StewardSync] Identity projection upsert failed while wallet-linking user ${existingByWallet.id}: ${describeSyncError(error)}`,
        );
        throw error;
      }

      const linkedUser = await usersService.getByStewardIdForWrite(stewardUserId);
      if (!linkedUser) {
        throw new Error(
          `Failed to fetch user after Steward wallet account linking for ${walletAddress}`,
        );
      }
      return linkedUser;
    }
  }

  // ── 5. Create new user + organization ────────────────────────────────

  // Generate organization slug
  let orgSlug: string;
  if (email) {
    orgSlug = generateSlugFromEmail(email);
  } else if (walletAddress) {
    orgSlug = generateSlugFromWallet(walletAddress);
  } else if (name) {
    orgSlug = generateSlugFromName(name);
  } else {
    throw new Error(`Cannot generate organization slug for Steward user ${stewardUserId}`);
  }

  // Ensure slug uniqueness
  let attempts = 0;
  while (await organizationsService.getBySlug(orgSlug)) {
    attempts++;
    if (attempts > 10) {
      throw new Error(
        `Failed to generate unique organization slug for Steward user ${stewardUserId}`,
      );
    }
    orgSlug = email
      ? generateSlugFromEmail(email)
      : walletAddress
        ? generateSlugFromWallet(walletAddress)
        : generateSlugFromName(name);
  }

  // Create organization with zero balance initially
  const organization = await organizationsService.create({
    name: `${name}'s Organization`,
    slug: orgSlug,
    credit_balance: SIGNUP_CREDIT_POLICY.openingBalanceUsd,
  });

  // Cloud identity is created at $0. Shared service access is not a credit
  // grant, and purchased credits remain exclusive to explicit funding paths.
  const initialCreditsGranted = false;
  const initialFreeCreditsUsd = SIGNUP_CREDIT_POLICY.automaticGrantUsd;

  // Create user, handle race conditions
  let createdUser: Awaited<ReturnType<typeof usersService.create>> | undefined;

  try {
    createdUser = await usersService.create({
      steward_user_id: stewardUserId,
      email: email || null,
      email_verified: !!email,
      wallet_address: walletAddress || null,
      wallet_chain_type: resolvedWalletChainType || null,
      wallet_verified: Boolean(walletAddress),
      phone_number: verifiedPhone || null,
      phone_verified: Boolean(verifiedPhone),
      name,
      avatar: getRandomUserAvatar(),
      organization_id: organization.id,
      role: "owner",
      is_active: true,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      let existingUser: UserWithOrganization | undefined;
      const maxRetries = 3;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
        }

        existingUser = await usersService.getByStewardIdForWrite(stewardUserId);
        if (existingUser) break;

        if (email) {
          existingUser = await usersService.getByEmailWithOrganization(email);
        }

        if (!existingUser && walletAddress) {
          existingUser = await findUserByStoredWalletAddress(walletAddress);
        }

        if (existingUser) {
          if (verifiedPhone) {
            await linkVerifiedPhoneForStewardSync(existingUser.id, verifiedPhone);
          }
          if (existingUser.steward_user_id !== stewardUserId) {
            // NOTE: This is the link path that the Steward identity-link DB
            // migration drafts depend on (see
            // packages/db/migrations/_drafts_steward_link/README.md, Phase 2).
            // The match-by-email or match-by-wallet branches above find the
            // existing auth row, and this block writes the
            // steward_user_id link onto both `users` and `user_identities`.
            // The drafted Phase 3 migration will not run until the
            // unlinked-active-user count hits zero, which depends on this
            // path executing for every active user.
            logger.info(
              `[StewardSync] Linking Steward account for ${email}: ${existingUser.steward_user_id} → ${stewardUserId}`,
            );
            const previousStewardUserId = existingUser.steward_user_id;
            await usersService.update(existingUser.id, {
              steward_user_id: stewardUserId,
              updated_at: new Date(),
            });
            try {
              await usersService.upsertStewardIdentity(existingUser.id, stewardUserId);
            } catch (upsertError) {
              await usersService.update(existingUser.id, {
                steward_user_id: previousStewardUserId,
                updated_at: new Date(),
              });
              throw upsertError;
            }
            await organizationsService.delete(organization.id);
            const linkedUser = await usersService.getByStewardIdForWrite(stewardUserId);
            if (!linkedUser) {
              throw new Error(`Failed to fetch user after Steward account linking for ${email}`);
            }
            return linkedUser;
          }
          break;
        }
      }

      if (existingUser) {
        await organizationsService.delete(organization.id);
        return existingUser;
      }

      logger.error(
        `[StewardSync] Duplicate key error but user (steward: ${stewardUserId}) not found after ${maxRetries} retries`,
      );
      await organizationsService.delete(organization.id);
    }

    logger.error(
      `[StewardSync] Failed to create user for ${stewardUserId}: ${describeSyncError(error)}`,
    );
    throw error;
  }

  if (!createdUser) {
    throw new Error(`Failed to create user for Steward user ${stewardUserId}`);
  }

  // Upsert identity projection
  try {
    await usersService.upsertStewardIdentity(createdUser.id, stewardUserId);
  } catch (error) {
    const recovered = await recoverCanonicalStewardUser(
      createdUser.id,
      stewardUserId,
      "signup",
      error,
    );

    if (!recovered) {
      await rollbackCreatedUserSafely(createdUser.id, "signup", error);
      await organizationsService.delete(organization.id);
      logger.error(
        `[StewardSync] Identity projection upsert failed for new user ${createdUser.id}: ${describeSyncError(error)}`,
      );
      throw error;
    }
  }

  // Fetch final user with organization
  const userWithOrg = await usersService.getByStewardIdForWrite(stewardUserId);

  if (!userWithOrg) {
    throw new Error(`Failed to fetch newly created Steward user ${stewardUserId}`);
  }

  // Send welcome email (fire-and-forget)
  const recipientEmail = email || userWithOrg.organization?.billing_email;
  if (recipientEmail) {
    queueWelcomeEmail({
      email: recipientEmail,
      userName: name || "there",
      organizationName: userWithOrg.organization?.name || "",
    }).catch((error) => {
      logger.error("[StewardSync] Failed to send welcome email:", { error });
    });
  } else {
    logger.warn("[StewardSync] No email available for welcome email", {
      userId: userWithOrg.id,
      stewardUserId,
      walletAddress,
    });
  }

  // Log to Discord (fire-and-forget)
  discordService
    .logUserSignup({
      userId: userWithOrg.id,
      stewardUserId: userWithOrg.steward_user_id || "",
      email: userWithOrg.email || null,
      name: userWithOrg.name || null,
      walletAddress: userWithOrg.wallet_address || null,
      organizationId: userWithOrg.organization?.id || "",
      organizationName: userWithOrg.organization?.name || "",
      role: userWithOrg.role,
      isNewOrganization: true,
    })
    .catch((error) => {
      logger.error("[StewardSync] Discord signup log failed:", { error });
    });

  // Await default provisioning: on Cloudflare Workers an un-awaited promise is
  // cancelled once the response returns unless registered via
  // executionCtx.waitUntil, which this shared-lib function cannot reach — and a
  // cancelled create leaves the new user permanently without a default
  // character/API key (later logins return at the existing-user branch). Both
  // default-key provisioning is required for signup to be usable; the default
  // character helper keeps its own retry-on-next-session behavior.
  await apiKeysService.provisionDefaultApiKey(userWithOrg.id, userWithOrg.organization?.id || "");
  await ensureDefaultCharacter(userWithOrg.id, userWithOrg.organization?.id || "");

  // Provision the org's Steward tenant EAGERLY at signup (#14645). Previously
  // this only happened lazily at first agent-provision, so a brand-new user
  // had no Steward tenant and `GET /steward/user/me/tenants` 403'd -> the app
  // read that as "not authenticated" and bounced to /login in a loop, and the
  // user could never reach agent-provision to self-heal (chicken-and-egg;
  // 629/630 staging orgs had a NULL steward_tenant_id). Provisioning it here
  // makes /me/tenants resolve 200 on the first post-signup request.
  //
  // FAIL-OPEN: a Steward outage must NOT block signup. `ensureStewardTenant`
  // is idempotent (409-tolerant) and the agent-provision call site still
  // self-heals later, so on failure we log and proceed rather than roll back
  // the just-created account -- same non-fatal posture as the welcome-credit
  // and default-character provisioning above.
  const eagerTenantOrgId = userWithOrg.organization?.id;
  if (eagerTenantOrgId) {
    try {
      await ensureStewardTenant(eagerTenantOrgId);
    } catch (error) {
      logger.warn(
        `[StewardSync] Eager Steward tenant provisioning failed for new org ${eagerTenantOrgId}; signup proceeds and agent-provision will retry: ${describeSyncError(error)}`,
      );
    }
  }

  return {
    ...userWithOrg,
    initialCreditsGranted,
    initialFreeCreditsUsd,
  };
}

/**
 * Converges Steward's signed Telegram subject with the gateway's durable
 * sender identity. A mutable username is never identity authority. Message-
 * first provisional accounts are promoted before generic sync can create a
 * duplicate; website-first accounts are linked after ordinary provisioning.
 */
export async function syncUserFromSteward(params: StewardSyncParams): Promise<StewardSyncedUser> {
  const verifiedTelegramId = params.verifiedTelegramId?.trim();
  if (verifiedTelegramId && !/^\d{1,20}$/.test(verifiedTelegramId)) {
    throw new StewardTelegramAccountClaimError("invalid_verified_telegram_id");
  }

  if (verifiedTelegramId) {
    const [telegramOwner, stewardOwner] = await Promise.all([
      usersRepository.findByTelegramIdWithOrganizationForWrite(verifiedTelegramId),
      usersService.getByStewardIdForWrite(params.stewardUserId),
    ]);

    if (telegramOwner && stewardOwner && telegramOwner.id !== stewardOwner.id) {
      throw new StewardTelegramAccountClaimError("telegram_owned_by_other_cloud_account");
    }

    if (telegramOwner && !stewardOwner) {
      if (!telegramOwner.organization_id) {
        throw new StewardTelegramAccountClaimError("telegram_account_has_no_organization");
      }
      const provisionalStewardId = `telegram:${verifiedTelegramId}`;
      if (
        telegramOwner.steward_user_id !== provisionalStewardId &&
        telegramOwner.steward_user_id !== params.stewardUserId
      ) {
        throw new StewardTelegramAccountClaimError("telegram_owned_by_mature_account");
      }
      const promotion = await usersRepository.promoteTelegramPersonalAccountToSteward({
        telegramId: verifiedTelegramId,
        stewardUserId: params.stewardUserId,
        expectedUserId: telegramOwner.id,
        expectedOrganizationId: telegramOwner.organization_id,
      });
      if (promotion.status !== "promoted" && promotion.status !== "already_promoted") {
        throw new StewardTelegramAccountClaimError(promotion.status);
      }
    }
  }

  const user = await syncUserFromStewardBase(params);
  if (!verifiedTelegramId) return user;

  try {
    const linked = await usersRepository.linkTelegramIdentity(user.id, {
      telegram_id: verifiedTelegramId,
    });
    if (!linked) {
      throw new StewardTelegramAccountClaimError("telegram_link_user_not_found");
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new StewardTelegramAccountClaimError("telegram_link_conflict");
  }
  await invalidateBoundPersonalDeliveryProjection("telegram", verifiedTelegramId);
  const linkedUser = await usersService.getByStewardIdForWrite(params.stewardUserId);
  if (!linkedUser || linkedUser.telegram_id !== verifiedTelegramId) {
    throw new StewardTelegramAccountClaimError("telegram_link_readback_failed");
  }
  return linkedUser;
}

/**
 * Ensures an account has a default Eliza character and matching runtime
 * mirror, seeding from the default template when the organization has none.
 *
 * Idempotent and never rejects. Called from two places: the one-time
 * new-user signup branch above, and every session-cache miss
 * (auth.ts getCurrentUserFromRequest). The second call site is the recovery
 * path: a create that fails at signup is swallowed here (signup must not
 * fail over provisioning), so without the session-time re-run the account
 * would stay character-less forever — the default character is
 * deterministically reconstructable, so re-seeding is always safe. A healthy
 * character+mirror pair exits through a read-intent probe; absent or
 * inconsistent state reaches CharactersService's locked bootstrap authority,
 * whose ensure-if-absent also repairs legacy character rows.
 */
export async function ensureDefaultCharacter(
  userId: string,
  organizationId: string,
): Promise<void> {
  if (!userId?.trim() || !organizationId?.trim()) {
    logger.warn("[StewardSync] Invalid userId or organizationId, skipping default character");
    return;
  }

  try {
    if (await charactersService.hasHealthyCloudCharacterMirror(organizationId)) {
      return;
    }

    const defaultData = getDefaultElizaCharacterData();
    await charactersService.create(
      {
        ...defaultData,
        user_id: userId,
        organization_id: organizationId,
      },
      { policy: { mode: "bootstrap" } },
    );

    logger.info(`[StewardSync] Ensured default Eliza character for user ${userId}`);
  } catch (error) {
    // error-policy:J1 provisioning boundary: a default-character failure
    // must not fail signup or session resolution; it is logged here and
    // deterministically retried by the next session-cache-miss re-run
    // (auth.ts getCurrentUserFromRequest), which is where recovery lands.
    logger.error("[StewardSync] Error creating default character", {
      userId,
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Queues a welcome email for a new Steward user.
 */
async function queueWelcomeEmail(data: {
  email: string;
  userName: string;
  organizationName: string;
}): Promise<void> {
  await emailService.sendWelcomeEmail({
    ...data,
    dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL || ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin}/cloud`,
  });
}
