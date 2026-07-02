/**
 * Service for managing organization invites.
 */

import {
  type NewOrganizationInvite,
  type OrganizationInvite,
  organizationInvitesRepository,
} from "../../db/repositories";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { appsRepository } from "../../db/repositories/apps";
import { userCharactersRepository } from "../../db/repositories/characters";
import { containersRepository } from "../../db/repositories/containers";
import { conversationsRepository } from "../../db/repositories/conversations";
import { getInitialCredits } from "../signup-credits";
import { generateInviteToken, hashInviteToken } from "../utils/invite-tokens";
import { logger } from "../utils/logger";
import { emailService } from "./email";
import { managedDomainsService } from "./managed-domains";
import { organizationsService } from "./organizations";
import { usersService } from "./users";

/**
 * Parameters for creating an organization invite.
 */
export interface CreateInviteParams {
  organizationId: string;
  inviterUserId: string;
  invitedEmail: string;
  invitedRole: "admin" | "member";
}

/**
 * Invite with organization details.
 */
export interface InviteWithOrganization extends OrganizationInvite {
  organization: {
    id: string;
    name: string;
    slug: string;
  };
}

/**
 * Result of validating an invite token.
 */
export interface ValidateTokenResult {
  valid: boolean;
  invite?: InviteWithOrganization;
  error?: string;
}

/**
 * Service for managing organization invites including creation, validation, and acceptance.
 */
export class InvitesService {
  async getById(id: string): Promise<OrganizationInvite | undefined> {
    return await organizationInvitesRepository.findById(id);
  }

  async listByOrganization(organizationId: string): Promise<OrganizationInvite[]> {
    return await organizationInvitesRepository.listByOrganization(organizationId);
  }

  async listPendingByOrganization(organizationId: string): Promise<OrganizationInvite[]> {
    return await organizationInvitesRepository.listPendingByOrganization(organizationId);
  }

  async findPendingInviteByEmail(email: string): Promise<OrganizationInvite | undefined> {
    return await organizationInvitesRepository.findPendingInviteByEmail(email.toLowerCase());
  }

  async createInvite(params: CreateInviteParams): Promise<{
    invite: OrganizationInvite;
    token: string;
  }> {
    const { organizationId, inviterUserId, invitedEmail, invitedRole } = params;

    const normalizedEmail = invitedEmail.toLowerCase().trim();

    if (!["admin", "member"].includes(invitedRole)) {
      throw new Error("Invalid role. Must be 'admin' or 'member'");
    }

    const existingUser = await usersService.getByEmailWithOrganization(normalizedEmail);
    if (existingUser && existingUser.organization_id === organizationId) {
      throw new Error("User is already a member of this organization");
    }

    const existingInvite =
      await organizationInvitesRepository.findPendingInviteByEmail(normalizedEmail);
    if (existingInvite && existingInvite.organization_id === organizationId) {
      throw new Error("An invite for this email is already pending");
    }

    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const inviteData: NewOrganizationInvite = {
      organization_id: organizationId,
      inviter_user_id: inviterUserId,
      invited_email: normalizedEmail,
      invited_role: invitedRole,
      token_hash: tokenHash,
      expires_at: expiresAt,
      status: "pending",
      created_at: new Date(),
      updated_at: new Date(),
    };

    const invite = await organizationInvitesRepository.create(inviteData);

    const organization = await organizationsService.getById(organizationId);
    const inviter = await usersService.getById(inviterUserId);

    if (organization && inviter) {
      await emailService.sendInviteEmail({
        email: normalizedEmail,
        inviterName: inviter.name || "A team member",
        organizationName: organization.name,
        role: invitedRole,
        inviteToken: token,
        expiresAt: expiresAt.toISOString(),
      });
    }

    return { invite, token };
  }

  async validateToken(token: string): Promise<ValidateTokenResult> {
    const tokenHash = hashInviteToken(token);
    const invite = await organizationInvitesRepository.findByTokenHash(tokenHash);

    if (!invite) {
      return { valid: false, error: "Invalid invite" };
    }

    if (invite.status !== "pending") {
      let message = "Invite already used or revoked";
      if (invite.status === "accepted") {
        message = "This invite has already been accepted";
      } else if (invite.status === "revoked") {
        message = "This invite has been revoked";
      } else if (invite.status === "expired") {
        message = "This invite has expired";
      }
      return { valid: false, error: message };
    }

    if (new Date() > invite.expires_at) {
      await organizationInvitesRepository.markAsExpired(invite.id);
      return { valid: false, error: "Invite expired" };
    }

    return { valid: true, invite: invite as InviteWithOrganization };
  }

  async acceptInvite(token: string, userId: string): Promise<OrganizationInvite> {
    const validation = await this.validateToken(token);
    if (!validation.valid || !validation.invite) {
      throw new Error(validation.error || "Invalid invite");
    }

    const invite = validation.invite;
    const user = await usersService.getById(userId);

    if (!user) {
      throw new Error("User not found");
    }

    if (user.email?.toLowerCase() !== invite.invited_email) {
      throw new Error(`Please sign in with ${invite.invited_email} to accept this invite`);
    }

    if (user.organization_id === invite.organization_id) {
      throw new Error("You are already a member of this organization");
    }

    // Every self-signup provisions its user as the OWNER of a fresh solo org
    // (steward-sync), so a blanket owner block would dead-end every existing
    // account (#11332). An owner may accept iff their current org is an empty
    // solo org: no other members, no deployed apps/agents/domains, and no more
    // credits than the signup grant. Anything richer keeps the block with an
    // actionable error — abandoning a real org needs an explicit path.
    const vacatedSoloOrgId = user.role === "owner" ? user.organization_id : null;
    if (vacatedSoloOrgId) {
      await this.assertOwnerCanVacateSoloOrganization(user.id, vacatedSoloOrgId);
    }

    const movedUser = await usersService.update(userId, {
      organization_id: invite.organization_id,
      role: invite.invited_role,
      updated_at: new Date(),
    });

    const updatedInvite = await organizationInvitesRepository.markAsAccepted(invite.id, userId);

    if (!updatedInvite) {
      throw new Error("Failed to mark invite as accepted");
    }

    if (vacatedSoloOrgId && movedUser?.organization_id === invite.organization_id) {
      await this.cleanUpVacatedSoloOrganization(userId, vacatedSoloOrgId, invite.organization_id);
    }

    return updatedInvite;
  }

  /**
   * Gate for an owner accepting an invite: their current org must be an empty
   * solo org (the auto-provisioned signup artifact), not a real organization.
   */
  private async assertOwnerCanVacateSoloOrganization(
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const members = await usersService.listByOrganization(organizationId);
    if (members.some((member) => member.id !== userId)) {
      throw new Error(
        "You cannot join another organization while your current organization has other members. Transfer ownership or remove them first.",
      );
    }

    const [appCount, containers, retainedAgentCount, managedDomainCount] = await Promise.all([
      appsRepository.countByOrganization(organizationId),
      containersRepository.listByOrganization(organizationId),
      agentSandboxesRepository.countRetainedByOrganization(organizationId),
      managedDomainsService.countForOrganization(organizationId),
    ]);
    const deployedContainers = containers.filter(
      (container) => container.status !== "deleted" && container.status !== "deleting",
    );
    if (
      appCount > 0 ||
      deployedContainers.length > 0 ||
      retainedAgentCount > 0 ||
      managedDomainCount > 0
    ) {
      throw new Error(
        "You cannot join another organization while your current organization has deployed apps, agents, or managed domains. Delete or transfer them first.",
      );
    }

    const organization = await organizationsService.getById(organizationId);
    if (organization && Number(organization.credit_balance) > getInitialCredits()) {
      throw new Error(
        "You cannot join another organization while your current organization holds credits beyond the signup grant. Contact support to transfer them first.",
      );
    }
  }

  /**
   * After a sole-member owner moved into the inviting org: re-home their
   * characters and conversations (the org cascade would destroy them), then
   * delete the now-empty solo org. The accept itself has already committed, so
   * cleanup failure is logged, never surfaced as a request failure.
   */
  private async cleanUpVacatedSoloOrganization(
    userId: string,
    previousOrganizationId: string,
    newOrganizationId: string,
  ): Promise<void> {
    try {
      const remaining = await usersService.listByOrganization(previousOrganizationId);
      if (remaining.some((member) => member.id !== userId)) {
        logger.warn(
          "[InvitesService] Vacated org gained a member mid-accept; leaving it in place",
          {
            previousOrganizationId,
            userId,
          },
        );
        return;
      }
      await userCharactersRepository.reassignUserOrganization(
        userId,
        previousOrganizationId,
        newOrganizationId,
      );
      await conversationsRepository.reassignUserOrganization(
        userId,
        previousOrganizationId,
        newOrganizationId,
      );
      await this.assertOwnerCanVacateSoloOrganization(userId, previousOrganizationId);
      await organizationsService.delete(previousOrganizationId);
    } catch (error) {
      logger.warn("[InvitesService] Failed to clean up vacated solo organization", {
        previousOrganizationId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async revokeInvite(inviteId: string, organizationId: string): Promise<OrganizationInvite> {
    const invite = await organizationInvitesRepository.findById(inviteId);

    if (!invite) {
      throw new Error("Invite not found");
    }

    if (invite.organization_id !== organizationId) {
      throw new Error("Invite does not belong to this organization");
    }

    if (invite.status !== "pending") {
      throw new Error("Can only revoke pending invites");
    }

    const revoked = await organizationInvitesRepository.revoke(inviteId);

    if (!revoked) {
      throw new Error("Failed to revoke invite");
    }

    return revoked;
  }
}

export const invitesService = new InvitesService();
