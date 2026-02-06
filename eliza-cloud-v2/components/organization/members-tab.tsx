/**
 * Members tab component for managing organization members and invites.
 * Displays current members, pending invites, and provides invite functionality.
 *
 * @param props - Members tab configuration
 * @param props.user - User data with organization information
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { UserPlus, Loader2 } from "lucide-react";
import type { UserWithOrganization } from "@/lib/types";
import { InviteMemberDialog } from "./invite-member-dialog";
import { MembersList } from "./members-list";
import { PendingInvitesList } from "./pending-invites-list";
import { toast } from "sonner";
import { BrandButton } from "@/components/brand";

interface MembersTabProps {
  user: UserWithOrganization;
}

interface OrganizationMember {
  id: string;
  user_id: string;
  organization_id: string;
  role: string;
  user?: {
    id: string;
    email: string;
    name: string | null;
    avatar_url: string | null;
  };
  created_at: string;
}

interface OrganizationInvite {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export function MembersTab({ user }: MembersTabProps) {
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [invites, setInvites] = useState<OrganizationInvite[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(true);
  const [isLoadingInvites, setIsLoadingInvites] = useState(true);

  const fetchMembers = useCallback(async () => {
    setIsLoadingMembers(true);
    const response = await fetch("/api/organizations/members");
    const data = await response.json();

    if (data.success) {
      setMembers(data.data);
    } else {
      toast.error("Failed to load members");
    }
    setIsLoadingMembers(false);
  }, []);

  const fetchInvites = useCallback(async () => {
    setIsLoadingInvites(true);
    const response = await fetch("/api/organizations/invites");
    const data = await response.json();

    if (data.success) {
      setInvites(data.data);
    } else {
      toast.error("Failed to load invites");
    }
    setIsLoadingInvites(false);
  }, []);

  useEffect(() => {
    // Use queueMicrotask to defer execution and avoid synchronous setState
    queueMicrotask(() => {
      fetchMembers();
      fetchInvites();
    });
  }, [fetchMembers, fetchInvites]);

  const handleInviteSuccess = () => {
    setIsInviteDialogOpen(false);
    fetchInvites();
    toast.success("Invitation sent successfully");
  };

  const handleRevokeInvite = async (inviteId: string) => {
    const response = await fetch(`/api/organizations/invites/${inviteId}`, {
      method: "DELETE",
    });

    const data = await response.json();

    if (data.success) {
      toast.success("Invitation revoked");
      fetchInvites();
    } else {
      toast.error(data.error || "Failed to revoke invitation");
    }
  };

  const handleUpdateMemberRole = async (userId: string, newRole: string) => {
    const response = await fetch(`/api/organizations/members/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });

    const data = await response.json();

    if (data.success) {
      toast.success("Member role updated");
      fetchMembers();
    } else {
      toast.error(data.error || "Failed to update member role");
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!confirm("Are you sure you want to remove this member?")) {
      return;
    }

    const response = await fetch(`/api/organizations/members/${userId}`, {
      method: "DELETE",
    });

    const data = await response.json();

    if (data.success) {
      toast.success("Member removed");
      fetchMembers();
    } else {
      toast.error(data.error || "Failed to remove member");
    }
  };

  const canManageMembers = user.role === "owner" || user.role === "admin";
  const isOwner = user.role === "owner";

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header with Invite Button */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base md:text-lg font-mono font-semibold text-white">
            Team Members
          </h3>
          <p className="text-xs md:text-sm font-mono text-white/60">
            Manage who has access to your organization
          </p>
        </div>
        {canManageMembers && (
          <button
            type="button"
            onClick={() => setIsInviteDialogOpen(true)}
            className="relative bg-[#e1e1e1] px-3 py-2 overflow-hidden hover:bg-white transition-colors flex items-center gap-2 w-full sm:w-auto"
          >
            <div
              className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
              style={{
                backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                backgroundSize: "2.915576934814453px 2.915576934814453px",
              }}
            />
            <UserPlus className="relative z-10 h-4 w-4 text-black" />
            <span className="relative z-10 text-black font-mono font-medium text-sm md:text-base">
              Invite Member
            </span>
          </button>
        )}
      </div>

      {/* Members List */}
      {isLoadingMembers ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-[#FF5800]" />
        </div>
      ) : (
        <MembersList
          members={members}
          currentUserId={user.id}
          currentUserRole={user.role}
          isOwner={isOwner}
          onUpdateRole={handleUpdateMemberRole}
          onRemove={handleRemoveMember}
        />
      )}

      {/* Pending Invites */}
      {canManageMembers && (
        <div className="pt-4 md:pt-6 border-t border-white/10">
          <h3 className="text-base md:text-lg font-mono font-semibold mb-3 md:mb-4 text-white">
            Pending Invitations
          </h3>
          {isLoadingInvites ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-[#FF5800]" />
            </div>
          ) : (
            <PendingInvitesList
              invites={invites}
              onRevoke={handleRevokeInvite}
            />
          )}
        </div>
      )}

      {/* Invite Member Dialog */}
      <InviteMemberDialog
        isOpen={isInviteDialogOpen}
        onClose={() => setIsInviteDialogOpen(false)}
        onSuccess={handleInviteSuccess}
      />
    </div>
  );
}
