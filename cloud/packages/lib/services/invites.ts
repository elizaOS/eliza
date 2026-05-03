/**
 * Service for managing organization invites.
 */

import {
  type NewOrganizationInvite,
  type OrganizationInvite,
  organizationInvitesRepository,
} from "@/db/repositories";
import { generateInviteToken, hashInviteToken } from "@/lib/utils/invite-tokens";
import { emailService } from "./email";
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

    if (user.role === "owner") {
      throw new Error(
        "Organization owners cannot join other organizations. Contact support for assistance.",
      );
    }

    await usersService.update(userId, {
      organization_id: invite.organization_id,
      role: invite.invited_role,
      updated_at: new Date(),
    });

    const updatedInvite = await organizationInvitesRepository.markAsAccepted(invite.id, userId);

    if (!updatedInvite) {
      throw new Error("Failed to mark invite as accepted");
    }

    return updatedInvite;
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
