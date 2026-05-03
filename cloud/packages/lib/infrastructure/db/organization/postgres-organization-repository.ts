import { organizationsRepository } from "@/db/repositories";
import type {
  NewOrganization,
  Organization,
  UpdateCreditBalanceResult,
} from "@/lib/domain/organization/organization";
import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class PostgresOrganizationRepository implements OrganizationRepository {
  findById(id: string): Promise<Organization | undefined> {
    return organizationsRepository.findById(id);
  }

  findBySlug(slug: string): Promise<Organization | undefined> {
    return organizationsRepository.findBySlug(slug);
  }

  findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<Organization | undefined> {
    return organizationsRepository.findByStripeCustomerId(stripeCustomerId);
  }

  findWithUsers(id: string): Promise<unknown> {
    return organizationsRepository.findWithUsers(id);
  }

  create(data: NewOrganization): Promise<Organization> {
    return organizationsRepository.create(data);
  }

  update(
    id: string,
    data: Partial<NewOrganization>,
  ): Promise<Organization | undefined> {
    return organizationsRepository.update(id, data);
  }

  updateCreditBalance(
    id: string,
    amount: number,
  ): Promise<UpdateCreditBalanceResult> {
    return organizationsRepository.updateCreditBalance(id, amount);
  }

  delete(id: string): Promise<void> {
    return organizationsRepository.delete(id);
  }

  // Postgres adapter has no cache to invalidate; the cached decorator overrides this.
  async invalidateCache(_id: string): Promise<void> {
    // intentionally empty
  }
}
