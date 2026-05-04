/**
 * Caching decorator for `UserRepository`.
 *
 * Users have many lookup paths (id / email / stewardId / privyId /
 * walletAddress, with and without organization). This decorator caches
 * the read paths used by the Hono-scope use cases and invalidates ALL
 * known keys for a user on writes — same multi-key sync pattern that
 * lived in the legacy `usersService.invalidateCache`.
 */

import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import type { Cache } from "@/lib/domain/cache/cache";
import type {
  NewUser,
  User,
  UserWithOrganization,
} from "@/lib/domain/user/user";
import type { UserRepository } from "@/lib/domain/user/user-repository";

export class CachedUserRepository implements UserRepository {
  constructor(
    private readonly inner: UserRepository,
    private readonly cache: Cache,
  ) {}

  async findById(id: string): Promise<User | undefined> {
    const result = await this.cache.wrapNullable<User>(
      async () => (await this.inner.findById(id)) ?? null,
      { key: CacheKeys.user.byId(id), ttl: CacheTTL.user.byId },
    );
    return result ?? undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const result = await this.cache.wrapNullable<User>(
      async () => (await this.inner.findByEmail(email)) ?? null,
      { key: CacheKeys.user.byEmail(email), ttl: CacheTTL.user.byEmail },
    );
    return result ?? undefined;
  }

  async findByStewardId(
    stewardUserId: string,
  ): Promise<UserWithOrganization | undefined> {
    const result = await this.cache.wrapNullable<UserWithOrganization>(
      async () => (await this.inner.findByStewardId(stewardUserId)) ?? null,
      {
        key: CacheKeys.user.byStewardIdWithOrg(stewardUserId),
        ttl: CacheTTL.user.byStewardId,
      },
    );
    return result ?? undefined;
  }

  async findWithOrganization(
    userId: string,
  ): Promise<UserWithOrganization | undefined> {
    const result = await this.cache.wrapNullable<UserWithOrganization>(
      async () => (await this.inner.findWithOrganization(userId)) ?? null,
      { key: CacheKeys.user.withOrg(userId), ttl: CacheTTL.user.byId },
    );
    return result ?? undefined;
  }

  listByOrganization(organizationId: string): Promise<User[]> {
    return this.inner.listByOrganization(organizationId);
  }

  create(data: NewUser): Promise<User> {
    return this.inner.create(data);
  }

  async update(id: string, data: Partial<NewUser>): Promise<User | undefined> {
    const existing = await this.inner.findById(id);
    const updated = await this.inner.update(id, data);
    if (existing) await this.invalidateCache(existing);
    if (updated && updated !== existing) await this.invalidateCache(updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.inner.findById(id);
    await this.inner.delete(id);
    if (existing) await this.invalidateCache(existing);
  }

  async invalidateCache(user: User | UserWithOrganization): Promise<void> {
    const promises: Promise<void>[] = [
      this.cache.del(CacheKeys.user.byId(user.id)),
      this.cache.del(CacheKeys.user.withOrg(user.id)),
    ];
    if (user.email) {
      promises.push(this.cache.del(CacheKeys.user.byEmail(user.email)));
      promises.push(this.cache.del(CacheKeys.user.byEmailWithOrg(user.email)));
    }
    if (typeof user.steward_user_id === "string") {
      promises.push(
        this.cache.del(CacheKeys.user.byStewardId(user.steward_user_id)),
      );
      promises.push(
        this.cache.del(CacheKeys.user.byStewardIdWithOrg(user.steward_user_id)),
      );
    }
    if (typeof user.privy_user_id === "string") {
      promises.push(
        this.cache.del(CacheKeys.user.byPrivyId(user.privy_user_id)),
      );
      promises.push(
        this.cache.del(CacheKeys.user.byPrivyIdWithOrg(user.privy_user_id)),
      );
    }
    if (typeof user.wallet_address === "string") {
      promises.push(
        this.cache.del(CacheKeys.user.byWalletAddress(user.wallet_address)),
      );
      promises.push(
        this.cache.del(
          CacheKeys.user.byWalletAddressWithOrg(user.wallet_address),
        ),
      );
    }
    await Promise.all(promises);
  }
}
