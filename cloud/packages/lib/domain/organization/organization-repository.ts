/**
 * Organization repository contract.
 */

import type {
  NewOrganization,
  Organization,
  UpdateCreditBalanceResult,
} from "@/lib/domain/organization/organization";

export interface OrganizationRepository {
  // ── Reads ────────────────────────────────────────────────────────────
  findById(id: string): Promise<Organization | undefined>;
  findBySlug(slug: string): Promise<Organization | undefined>;
  findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<Organization | undefined>;
  findWithUsers(id: string): Promise<unknown>;

  // ── Writes ───────────────────────────────────────────────────────────
  create(data: NewOrganization): Promise<Organization>;
  update(
    id: string,
    data: Partial<NewOrganization>,
  ): Promise<Organization | undefined>;
  updateCreditBalance(
    id: string,
    amount: number,
  ): Promise<UpdateCreditBalanceResult>;
  delete(id: string): Promise<void>;

  // ── Cache invalidation hook ──────────────────────────────────────────
  invalidateCache(id: string): Promise<void>;
}
