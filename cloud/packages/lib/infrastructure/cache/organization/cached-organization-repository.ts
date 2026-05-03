/**
 * Caching decorator for `OrganizationRepository`.
 *
 * Mirrors the `CachedApiKeyRepository` pattern: positive caching on
 * `findById` (the hot read path), eager invalidation on `update`,
 * `updateCreditBalance`, and `delete`. The slug + stripe-customer +
 * with-users reads pass through (low traffic, not worth caching).
 */

import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import type { Cache } from "@/lib/domain/cache/cache";
import type {
  NewOrganization,
  Organization,
  UpdateCreditBalanceResult,
} from "@/lib/domain/organization/organization";
import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class CachedOrganizationRepository implements OrganizationRepository {
  constructor(
    private readonly inner: OrganizationRepository,
    private readonly cache: Cache,
  ) {}

  async findById(id: string): Promise<Organization | undefined> {
    const key = CacheKeys.org.data(id);
    const result = await this.cache.wrapNullable<Organization>(
      async () => (await this.inner.findById(id)) ?? null,
      { key, ttl: CacheTTL.org.data },
    );
    return result ?? undefined;
  }

  findBySlug(slug: string): Promise<Organization | undefined> {
    return this.inner.findBySlug(slug);
  }

  findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<Organization | undefined> {
    return this.inner.findByStripeCustomerId(stripeCustomerId);
  }

  findWithUsers(id: string): Promise<unknown> {
    return this.inner.findWithUsers(id);
  }

  create(data: NewOrganization): Promise<Organization> {
    return this.inner.create(data);
  }

  async update(
    id: string,
    data: Partial<NewOrganization>,
  ): Promise<Organization | undefined> {
    const result = await this.inner.update(id, data);
    await this.invalidateCache(id);
    return result;
  }

  async updateCreditBalance(
    id: string,
    amount: number,
  ): Promise<UpdateCreditBalanceResult> {
    const result = await this.inner.updateCreditBalance(id, amount);
    await this.invalidateCache(id);
    return result;
  }

  async delete(id: string): Promise<void> {
    await this.inner.delete(id);
    await this.invalidateCache(id);
  }

  async invalidateCache(id: string): Promise<void> {
    await this.cache.del(CacheKeys.org.data(id));
    // Also invalidate the legacy balance-only cache key (preserves coherence
    // with the still-alive organizationsService singleton).
    await this.cache.del(CacheKeys.eliza.orgBalance(id));
  }
}
