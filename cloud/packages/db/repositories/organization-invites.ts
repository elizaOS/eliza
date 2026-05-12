import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewOrganizationInvite,
  type OrganizationInvite,
  organizationInvites,
} from "../schemas/organization-invites";

export type { NewOrganizationInvite, OrganizationInvite };

/**
 * Repository for organization invite database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class OrganizationInvitesRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds an organization invite by ID.
   */
  async findById(id: string): Promise<OrganizationInvite | undefined> {
    return await dbRead.query.organizationInvites.findFirst({
      where: eq(organizationInvites.id, id),
    });
  }

  /**
   * Finds an organization invite by token hash with organization and inviter data.
   */
  async findByTokenHash(tokenHash: string): Promise<OrganizationInvite | undefined> {
    return await dbRead.query.organizationInvites.findFirst({
      where: eq(organizationInvites.token_hash, tokenHash),
      with: {
        organization: true,
        inviter: true,
      },
    });
  }

  /**
   * Finds a pending invite by email address (case-insensitive).
   */
  async findPendingInviteByEmail(email: string): Promise<OrganizationInvite | undefined> {
    return await dbRead.query.organizationInvites.findFirst({
      where: and(
        eq(organizationInvites.invited_email, email.toLowerCase()),
        eq(organizationInvites.status, "pending"),
      ),
      with: {
        organization: true,
      },
    });
  }

  /**
   * Lists all invites for an organization with inviter information.
   */
  async listByOrganization(organizationId: string): Promise<OrganizationInvite[]> {
    return await dbRead.query.organizationInvites.findMany({
      where: eq(organizationInvites.organization_id, organizationId),
      with: {
        inviter: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: (invites, { desc }) => [desc(invites.created_at)],
    });
  }

  /**
   * Lists pending invites for an organization with inviter information.
   */
  async listPendingByOrganization(organizationId: string): Promise<OrganizationInvite[]> {
    return await dbRead.query.organizationInvites.findMany({
      where: and(
        eq(organizationInvites.organization_id, organizationId),
        eq(organizationInvites.status, "pending"),
      ),
      with: {
        inviter: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: (invites, { desc }) => [desc(invites.created_at)],
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new organization invite.
   */
  async create(data: NewOrganizationInvite): Promise<OrganizationInvite> {
    const [invite] = await dbWrite.insert(organizationInvites).values(data).returning();
    return invite;
  }

  /**
   * Updates an existing organization invite.
   */
  async update(
    id: string,
    data: Partial<NewOrganizationInvite>,
  ): Promise<OrganizationInvite | undefined> {
    const [updated] = await dbWrite
      .update(organizationInvites)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(organizationInvites.id, id))
      .returning();
    return updated;
  }

  /**
   * Revokes an organization invite by setting status to "revoked".
   */
  async revoke(id: string): Promise<OrganizationInvite | undefined> {
    return await this.update(id, {
      status: "revoked",
    });
  }

  /**
   * Marks an invite as accepted by a user.
   */
  async markAsAccepted(
    id: string,
    acceptedByUserId: string,
  ): Promise<OrganizationInvite | undefined> {
    return await this.update(id, {
      status: "accepted",
      accepted_at: new Date(),
      accepted_by_user_id: acceptedByUserId,
    });
  }

  /**
   * Marks an invite as expired.
   */
  async markAsExpired(id: string): Promise<OrganizationInvite | undefined> {
    return await this.update(id, {
      status: "expired",
    });
  }

  /**
   * Deletes an organization invite by ID.
   */
  async delete(id: string): Promise<void> {
    await dbWrite.delete(organizationInvites).where(eq(organizationInvites.id, id));
  }
}

/**
 * Singleton instance of OrganizationInvitesRepository.
 */
export const organizationInvitesRepository = new OrganizationInvitesRepository();
