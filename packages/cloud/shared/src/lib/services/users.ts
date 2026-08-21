/**
 * Users service for managing user accounts and organization relationships.
 */

import {
  apiKeysRepository,
  type NewUser,
  organizationsRepository,
  type User,
  type UserIdentity,
  type UserWithOrganization,
  usersRepository,
} from "../../db/repositories";
import { retryOnTransientDbError } from "../../db/retry-transient";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";
import {
  type PersonalDeliveryProjectionIdentity,
  runWithBoundPersonalDeliveryProjectionFences,
} from "./eliza-app/personal-delivery-projection-contract";
import {
  invalidateInferenceAuthContextsByKeyHashes,
  invalidateInferenceSessionAuthContexts,
} from "./inference-auth-cache";
import {
  revokeInferenceSessionsThrough,
  setInferenceSessionBindingActive,
  setInferenceSubjectActive,
} from "./inference-credential-revocation";

type PersonalDeliveryIdentitySource = Partial<
  Pick<User | UserIdentity, "telegram_id" | "discord_id" | "phone_number">
>;

const PERSONAL_DELIVERY_ROUTING_FIELDS = [
  "organization_id",
  "is_active",
  "telegram_id",
  "discord_id",
  "phone_number",
] as const;

function personalDeliveryRoutingIdentities(
  ...sources: Array<PersonalDeliveryIdentitySource | undefined>
): PersonalDeliveryProjectionIdentity[] {
  const identities = new Map<string, PersonalDeliveryProjectionIdentity>();
  for (const source of sources) {
    if (!source) continue;
    const candidates: PersonalDeliveryProjectionIdentity[] = [
      { platform: "telegram", platformUserId: source.telegram_id?.trim() ?? "" },
      { platform: "discord", platformUserId: source.discord_id?.trim() ?? "" },
      { platform: "phone", platformUserId: source.phone_number?.trim() ?? "" },
    ];
    for (const identity of candidates) {
      if (!identity.platformUserId) continue;
      identities.set(`${identity.platform}:${identity.platformUserId}`, identity);
    }
  }
  return [...identities.values()];
}

function getErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { error: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: (error as Error & { code?: string }).code,
    cause: error.cause ? getErrorDetails(error.cause) : undefined,
  };
}

/**
 * Personal-org slug for a detached member — mirrors the signup generators in
 * steward-sync.ts (email local-part / wallet prefix / name + entropy suffix).
 */
function generatePersonalOrgSlug(user: User): string {
  const base = user.email
    ? user.email.split("@")[0]
    : user.wallet_address
      ? `wallet-${user.wallet_address.substring(0, 8)}`
      : user.name || "user";
  const sanitized = base.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const random = Math.random().toString(36).substring(2, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  return `${sanitized}-${timestamp}${random}`;
}

/**
 * Service for user operations including organization lookups.
 */
export class UsersService {
  private async capturePersonalDeliveryRoutingIdentities(
    userId: string,
    canonicalUser: User | undefined,
  ): Promise<PersonalDeliveryProjectionIdentity[]> {
    const projectedIdentity = await usersRepository.findIdentityByUserIdForWrite(userId);
    return personalDeliveryRoutingIdentities(canonicalUser, projectedIdentity);
  }

  async invalidateCache(user: User | UserWithOrganization): Promise<void> {
    const promises: Promise<void>[] = [
      cache.del(CacheKeys.user.byId(user.id)),
      cache.del(CacheKeys.user.withOrg(user.id)),
    ];
    if (user.email) {
      promises.push(cache.del(CacheKeys.user.byEmail(user.email)));
      promises.push(cache.del(CacheKeys.user.byEmailWithOrg(user.email)));
    }
    const stewardUserId = user.steward_user_id;
    if (typeof stewardUserId === "string") {
      promises.push(cache.del(CacheKeys.user.byStewardId(stewardUserId)));
      promises.push(cache.del(CacheKeys.user.byStewardIdWithOrg(stewardUserId)));
      promises.push(invalidateInferenceSessionAuthContexts([stewardUserId]));
    }
    const walletAddress = user.wallet_address;
    if (typeof walletAddress === "string") {
      promises.push(cache.del(CacheKeys.user.byWalletAddress(walletAddress)));
      promises.push(cache.del(CacheKeys.user.byWalletAddressWithOrg(walletAddress)));
    }
    await Promise.all(promises);
    logger.debug("[UsersService] Invalidated cache for user:", user.id);
  }

  async getById(id: string): Promise<User | undefined> {
    const cacheKey = CacheKeys.user.byId(id);
    const cached = await cache.get<User>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byId:", id);
      return cached;
    }
    const user = await usersRepository.findById(id);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byId);
      logger.debug("[UsersService] Cached user data:", id);
    }
    return user;
  }

  async getByEmail(email: string): Promise<User | undefined> {
    const cacheKey = CacheKeys.user.byEmail(email);
    const cached = await cache.get<User>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byEmail");
      return cached;
    }
    const user = await usersRepository.findByEmail(email);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byEmail);
      logger.debug("[UsersService] Cached user data by email");
    }
    return user;
  }

  async getByStewardId(stewardUserId: string): Promise<UserWithOrganization | undefined> {
    const cacheKey = CacheKeys.user.byStewardId(stewardUserId);
    const cached = await cache.get<UserWithOrganization>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byStewardId");
      return cached;
    }

    try {
      // Auth hot path: this resolves on every authenticated request. A transient
      // DB connection blip (a Worker→Hyperdrive connection terminated mid-query,
      // an SSL-handshake EOF under load) must not turn a valid session into a
      // 500 — retry transient connection failures with bounded backoff before
      // surfacing. Non-transient errors are not retried.
      const user = await retryOnTransientDbError(
        () => usersRepository.findByStewardIdWithOrganization(stewardUserId),
        { attempts: 3 },
      );
      if (user) {
        await cache.set(cacheKey, user, CacheTTL.user.byStewardId);
        logger.debug("[UsersService] Cached user data by stewardId");
      }
      return user;
    } catch (error) {
      // error-policy:J2 auth hot path — read-replica lookup failed; add context and
      // fail over to the primary. Never fabricates a user; rethrows via the inner catch.
      const errorDetails = getErrorDetails(error);

      logger.warn("[UsersService] Read-path Steward lookup failed, retrying on primary", {
        stewardUserId,
        ...errorDetails,
      });

      try {
        return await retryOnTransientDbError(() => this.getByStewardIdForWrite(stewardUserId), {
          attempts: 2,
        });
      } catch (fallbackError) {
        // error-policy:J2 both replica and primary failed — record combined context and
        // rethrow the primary error (its cause chain is preserved) so the caller 500s.
        logger.error("[UsersService] Primary Steward lookup retry failed", {
          stewardUserId,
          readError: errorDetails,
          writeError: getErrorDetails(fallbackError),
        });
        throw fallbackError;
      }
    }
  }

  async getByStewardIdForWrite(stewardUserId: string): Promise<UserWithOrganization | undefined> {
    const user = await usersRepository.findByStewardIdWithOrganizationForWrite(stewardUserId);
    if (user) {
      await Promise.all([
        cache.set(CacheKeys.user.byStewardId(stewardUserId), user, CacheTTL.user.byStewardId),
        cache.set(
          CacheKeys.user.byStewardIdWithOrg(stewardUserId),
          user,
          CacheTTL.user.byStewardIdWithOrg,
        ),
      ]);
      logger.debug("[UsersService] Cached user data by stewardId from primary");
    }
    return user;
  }

  async getStewardIdentityForWrite(
    stewardUserId: string,
  ): Promise<{ user_id: string; steward_user_id: string } | undefined> {
    return await usersRepository.findIdentityByStewardIdForWrite(stewardUserId);
  }

  async getWithOrganization(userId: string): Promise<UserWithOrganization | undefined> {
    const cacheKey = CacheKeys.user.withOrg(userId);
    const cached = await cache.get<UserWithOrganization>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user withOrg:", userId);
      return cached;
    }
    const user = await usersRepository.findWithOrganization(userId);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.withOrg);
      logger.debug("[UsersService] Cached user withOrg data:", userId);
    }
    return user;
  }

  async getByEmailWithOrganization(email: string): Promise<UserWithOrganization | undefined> {
    const cacheKey = CacheKeys.user.byEmailWithOrg(email);
    const cached = await cache.get<UserWithOrganization>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byEmailWithOrg");
      return cached;
    }
    const user = await usersRepository.findByEmailWithOrganization(email);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byEmailWithOrg);
      logger.debug("[UsersService] Cached user data byEmailWithOrg");
    }
    return user;
  }

  /**
   * Both wallet readers key the cache on the LOWERCASED address, because that is
   * the value the repository actually queries on. Keying on the caller's
   * spelling gave an EIP-55 address its own entry that `invalidateCache` — which
   * only knows the stored lowercase form — could never delete, so an update was
   * invisible to any caller that passed a checksummed address until the TTL
   * expired.
   */
  async getByWalletAddress(walletAddress: string): Promise<User | undefined> {
    const lookupAddress = walletAddress.toLowerCase();
    const cacheKey = CacheKeys.user.byWalletAddress(lookupAddress);
    const cached = await cache.get<User>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byWalletAddress");
      return cached;
    }
    const user = await usersRepository.findByWalletAddress(lookupAddress);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byWalletAddress);
      logger.debug("[UsersService] Cached user data byWalletAddress");
    }
    return user;
  }

  async getByWalletAddressWithOrganization(
    walletAddress: string,
  ): Promise<UserWithOrganization | undefined> {
    const lookupAddress = walletAddress.toLowerCase();
    const cacheKey = CacheKeys.user.byWalletAddressWithOrg(lookupAddress);
    const cached = await cache.get<UserWithOrganization>(cacheKey);
    if (cached) {
      logger.debug("[UsersService] Cache hit for user byWalletAddressWithOrg");
      return cached;
    }
    const user = await usersRepository.findByWalletAddressWithOrganization(lookupAddress);
    if (user) {
      await cache.set(cacheKey, user, CacheTTL.user.byWalletAddressWithOrg);
      logger.debug("[UsersService] Cached user data byWalletAddressWithOrg");
    }
    return user;
  }

  async listByOrganization(organizationId: string): Promise<User[]> {
    return await usersRepository.listByOrganization(organizationId);
  }

  async create(data: NewUser): Promise<User> {
    const user = await usersRepository.create(data);
    await this.invalidateCache(user);
    return user;
  }

  /**
   * Inference hot path (#9981 review gap): drop every cached IAC identity for a
   * user's API keys so a deactivated/deleted user stops fast-pathing inference
   * immediately rather than authorizing until the authContext TTL expires. The
   * slow path enforces `user.is_active`, but the IAC cache short-circuits it.
   * Best-effort: a cache failure must never break the lifecycle write. Mirrors
   * the ban/suspend wiring already in admin.ts (reuses listByUser, no new reader).
   */
  private async invalidateInferenceAuthForUser(userId: string): Promise<void> {
    try {
      const keys = await apiKeysRepository.listByUser(userId);
      await invalidateInferenceAuthContextsByKeyHashes(keys.map((k) => k.key_hash));
    } catch (error) {
      // error-policy:J6 best-effort IAC cache eviction — a cache blip must not break the
      // lifecycle write (deactivate/detach/delete). The slow path still enforces is_active.
      logger.warn("[UsersService] Failed to invalidate inference auth cache for user", {
        userId,
        ...getErrorDetails(error),
      });
    }
  }

  async update(id: string, data: Partial<NewUser>): Promise<User | undefined> {
    const existing = await usersRepository.findByIdForWrite(id);
    const personalDeliveryRoutingChanged = PERSONAL_DELIVERY_ROUTING_FIELDS.some((field) =>
      Object.hasOwn(data, field),
    );
    const previousRoutingIdentities = personalDeliveryRoutingChanged
      ? await this.capturePersonalDeliveryRoutingIdentities(id, existing)
      : [];
    const requestedRoutingIdentities = personalDeliveryRoutingChanged
      ? personalDeliveryRoutingIdentities(data)
      : [];

    return runWithBoundPersonalDeliveryProjectionFences(
      [...previousRoutingIdentities, ...requestedRoutingIdentities],
      async () => {
        const movingOrganizations =
          typeof data.organization_id === "string" &&
          data.organization_id !== existing?.organization_id;
        const sessionAuthorityChanged =
          (typeof data.role === "string" && data.role !== existing?.role) ||
          (typeof data.steward_user_id === "string" &&
            data.steward_user_id !== existing?.steward_user_id);
        const sessionRevocationCutoff =
          movingOrganizations || sessionAuthorityChanged ? Math.floor(Date.now() / 1000) : null;
        if (movingOrganizations && existing?.organization_id) {
          await setInferenceSubjectActive(existing.organization_id, id, false, "membership");
        }
        if (
          typeof data.steward_user_id === "string" &&
          existing?.organization_id &&
          existing.steward_user_id &&
          data.steward_user_id !== existing.steward_user_id
        ) {
          await setInferenceSessionBindingActive(
            existing.organization_id,
            id,
            existing.steward_user_id,
            false,
          );
        }
        if (movingOrganizations && typeof data.organization_id === "string") {
          await setInferenceSubjectActive(data.organization_id, id, false, "membership");
          if (sessionRevocationCutoff !== null) {
            await revokeInferenceSessionsThrough(data.organization_id, id, sessionRevocationCutoff);
          }
        }
        if (data.is_active === false && existing?.organization_id) {
          await setInferenceSubjectActive(existing.organization_id, id, false, "account");
        }
        if (sessionRevocationCutoff !== null && existing?.organization_id) {
          await revokeInferenceSessionsThrough(
            existing.organization_id,
            id,
            sessionRevocationCutoff,
          );
        }
        const result = await usersRepository.update(id, data);
        if (result?.organization_id && typeof data.steward_user_id === "string") {
          // Repeat the activation even when the row already has this binding. A
          // prior attempt can commit the database update and then fail while
          // clearing the durable fence; the retry must finish that recovery.
          await setInferenceSessionBindingActive(
            result.organization_id,
            id,
            data.steward_user_id,
            true,
          );
        }
        if (existing) {
          await this.invalidateCache(existing);
        }
        if (result) {
          await this.invalidateCache(result);
        }
        // Deactivation: when is_active flips to false, evict the user's warm IAC
        // entries so the now-inactive account can no longer fast-path inference.
        if (data.is_active === false) {
          await this.invalidateInferenceAuthForUser(id);
        }
        if (data.is_active === true && result?.organization_id && !movingOrganizations) {
          await setInferenceSubjectActive(result.organization_id, id, true, "account");
        }
        if (typeof data.organization_id === "string" && result?.organization_id) {
          // Establish the account fence before clearing the move fence so an
          // inactive account is never briefly admitted between serialized writes.
          await setInferenceSubjectActive(result.organization_id, id, result.is_active, "account");
          await setInferenceSubjectActive(result.organization_id, id, true, "membership");
        }
        return result;
      },
    );
  }

  async upsertStewardIdentity(userId: string, stewardUserId: string): Promise<void> {
    const existingIdentity = await usersRepository.findIdentityByUserIdForWrite(userId);

    if (existingIdentity?.steward_user_id === stewardUserId) {
      const user = await usersRepository.findByIdForWrite(userId);
      if (user?.organization_id) {
        // The identity row may have committed before a prior attempt failed to
        // clear the durable binding fence. Make the idempotent retry complete
        // that activation before returning.
        await setInferenceSessionBindingActive(user.organization_id, userId, stewardUserId, true);
      }
      await Promise.all([
        cache.del(CacheKeys.user.byStewardId(stewardUserId)),
        cache.del(CacheKeys.user.byStewardIdWithOrg(stewardUserId)),
        invalidateInferenceSessionAuthContexts([stewardUserId]),
      ]);
      return;
    }

    const user = await usersRepository.findByIdForWrite(userId);
    if (user?.organization_id) {
      if (existingIdentity?.steward_user_id) {
        await setInferenceSessionBindingActive(
          user.organization_id,
          userId,
          existingIdentity.steward_user_id,
          false,
        );
      }
      await revokeInferenceSessionsThrough(
        user.organization_id,
        userId,
        Math.floor(Date.now() / 1000),
      );
    }

    await usersRepository.upsertStewardIdentity(userId, stewardUserId);
    if (user?.organization_id) {
      await setInferenceSessionBindingActive(user.organization_id, userId, stewardUserId, true);
    }

    const cacheDeletes = [
      cache.del(CacheKeys.user.byStewardId(stewardUserId)),
      cache.del(CacheKeys.user.byStewardIdWithOrg(stewardUserId)),
      invalidateInferenceSessionAuthContexts([stewardUserId]),
    ];

    if (existingIdentity?.steward_user_id && existingIdentity.steward_user_id !== stewardUserId) {
      cacheDeletes.push(
        cache.del(CacheKeys.user.byStewardId(existingIdentity.steward_user_id)),
        cache.del(CacheKeys.user.byStewardIdWithOrg(existingIdentity.steward_user_id)),
        invalidateInferenceSessionAuthContexts([existingIdentity.steward_user_id]),
      );
    }

    await Promise.all(cacheDeletes);
  }

  async linkStewardId(userId: string, stewardUserId: string): Promise<void> {
    const existing = await usersRepository.findByIdForWrite(userId);
    if (existing?.organization_id && existing.steward_user_id !== stewardUserId) {
      if (existing.steward_user_id) {
        await setInferenceSessionBindingActive(
          existing.organization_id,
          userId,
          existing.steward_user_id,
          false,
        );
      }
      await revokeInferenceSessionsThrough(
        existing.organization_id,
        userId,
        Math.floor(Date.now() / 1000),
      );
    }
    const updated = await usersRepository.linkStewardId(userId, stewardUserId);
    if (updated?.organization_id) {
      await setInferenceSessionBindingActive(updated.organization_id, userId, stewardUserId, true);
    }

    if (existing) {
      await this.invalidateCache(existing);
    }
    if (updated) {
      await this.invalidateCache(updated);
    }

    await Promise.all([
      cache.del(CacheKeys.user.byStewardId(stewardUserId)),
      cache.del(CacheKeys.user.byStewardIdWithOrg(stewardUserId)),
    ]);
  }

  /**
   * Detach a user from their current organization WITHOUT deleting the account
   * (#11332): removing an org member must not destroy their identity. The
   * removed user is moved to a fresh personal organization where they are
   * owner — the same shape signup auto-creates — and their API keys scoped to
   * the old organization are deactivated (those keys authenticate AS the old
   * org; a removed member must not keep spending its credits). The new org
   * starts at $0: detach is not signup, so no welcome credits — an
   * invite→remove cycle must not mint free credit.
   */
  async detachFromOrganization(id: string): Promise<User> {
    const user = await usersRepository.findByIdForWrite(id);
    if (!user) {
      throw new Error(`User ${id} not found`);
    }
    const previousRoutingIdentities = await this.capturePersonalDeliveryRoutingIdentities(id, user);
    return runWithBoundPersonalDeliveryProjectionFences(previousRoutingIdentities, async () => {
      if (user.organization_id) {
        await setInferenceSubjectActive(user.organization_id, id, false, "membership");
      }

      let slug = generatePersonalOrgSlug(user);
      let attempts = 0;
      while (await organizationsRepository.findBySlug(slug)) {
        attempts++;
        if (attempts > 10) {
          throw new Error(`Failed to generate unique organization slug for user ${id}`);
        }
        slug = generatePersonalOrgSlug(user);
      }

      const organization = await organizationsRepository.create({
        name: `${user.name || user.email || "User"}'s Organization`,
        slug,
        credit_balance: "0.00",
      });

      let updated: User | undefined;
      try {
        updated = await usersRepository.update(id, {
          organization_id: organization.id,
          role: "owner",
        });
        if (!updated) {
          throw new Error(`Failed to move user ${id} to personal organization ${organization.id}`);
        }
      } catch (error) {
        // Don't strand an empty org when the move fails.
        try {
          await organizationsRepository.delete(organization.id);
        } catch (rollbackError) {
          // error-policy:J6 best-effort rollback of the just-created empty org; log and
          // fall through to rethrow the original move failure (never masks it).
          logger.error("[UsersService] Failed to roll back personal org after detach failure", {
            userId: id,
            organizationId: organization.id,
            ...getErrorDetails(rollbackError),
          });
        }
        throw error;
      }

      if (user.organization_id) {
        await apiKeysService.deactivateByUserAndOrganization(id, user.organization_id);
      }

      await this.invalidateCache(user);
      await this.invalidateCache(updated);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    const user = await usersRepository.findByIdForWrite(id);

    if (!user) {
      throw new Error(`User ${id} not found`);
    }
    const routingIdentities = await this.capturePersonalDeliveryRoutingIdentities(id, user);
    await runWithBoundPersonalDeliveryProjectionFences(routingIdentities, async () => {
      const organizationId = user.organization_id;

      if (organizationId) {
        await setInferenceSubjectActive(organizationId, id, false, "account");
      }

      await this.invalidateCache(user);
      // Resolve + evict the user's cached IAC identities BEFORE the row is deleted:
      // at delete time the user is still active, so an is_active gate can't fire and
      // the key_hash set must be read while the keys still exist.
      await this.invalidateInferenceAuthForUser(id);
      await usersRepository.delete(id);

      // Check if this was the last user in the organization
      if (organizationId) {
        const remainingUsers = await usersRepository.listByOrganization(organizationId);

        // If no users remain, delete the organization
        if (remainingUsers.length === 0) {
          await organizationsRepository.delete(organizationId);
        }
      }
    });
  }

  /** Permanently erases a sole-user personal account without partial DB deletion. */
  async deletePersonalAccount(id: string, organizationId: string): Promise<void> {
    const user = await usersRepository.findByIdForWrite(id);
    if (!user) throw new Error(`User ${id} not found`);
    if (user.organization_id !== organizationId) {
      throw new Error("Account deletion organization does not match the user");
    }

    await setInferenceSubjectActive(organizationId, id, false, "account");
    await this.invalidateCache(user);
    await this.invalidateInferenceAuthForUser(id);
    await usersRepository.deletePersonalOrganizationAtomically(id, organizationId);
  }
}

// Export singleton instance
export const usersService = new UsersService();
