/**
 * Members tab component for managing organization members and invites.
 * Displays current members, pending invites, and provides invite functionality.
 * RBAC: owner > admin > member.
 *
 * @param props - Members tab configuration
 * @param props.user - User data with organization information
 */

import { Loader2, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  BrandButton,
} from "../../cloud-ui";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  canManageOrg,
  type InviteRole,
  isOrgOwner,
  type UserWithOrganizationDto,
} from "./data/cloud-org-types";
import {
  organizationErrorMessage,
  useOrganizationInvites,
  useOrganizationMembers,
  useRemoveMember,
  useRevokeInvite,
  useUpdateMemberRole,
} from "./data/use-organization";
import { InviteMemberDialog } from "./invite-member-dialog";
import { MembersList } from "./members-list";
import { PendingInvitesList } from "./pending-invites-list";

interface MembersTabProps {
  user: UserWithOrganizationDto;
}

export function MembersTab({ user }: MembersTabProps) {
  const t = useCloudT();
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [removeMemberId, setRemoveMemberId] = useState<string | null>(null);

  const canManageMembers = canManageOrg(user.role);
  const isOwner = isOrgOwner(user.role);

  const membersQuery = useOrganizationMembers(canManageMembers);
  const invitesQuery = useOrganizationInvites(canManageMembers);
  const revokeInvite = useRevokeInvite();
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();

  const members = membersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];

  const handleInviteSuccess = () => {
    // The dialog stays open on its copyable-link step; it closes itself.
    toast.success(
      t("cloud.membersTab.inviteSent", {
        defaultValue: "Invitation sent successfully",
      }),
    );
  };

  const handleRevokeInvite = async (inviteId: string) => {
    try {
      await revokeInvite.mutateAsync(inviteId);
      toast.success(
        t("cloud.membersTab.inviteRevoked", {
          defaultValue: "Invitation revoked",
        }),
      );
    } catch (error) {
      toast.error(
        organizationErrorMessage(
          error,
          t("cloud.membersTab.revokeFailed", {
            defaultValue: "Failed to revoke invitation",
          }),
        ),
      );
    }
  };

  const handleUpdateMemberRole = async (userId: string, newRole: string) => {
    try {
      await updateRole.mutateAsync({ userId, role: newRole as InviteRole });
      toast.success(
        t("cloud.membersTab.roleUpdated", {
          defaultValue: "Member role updated",
        }),
      );
    } catch (error) {
      toast.error(
        organizationErrorMessage(
          error,
          t("cloud.membersTab.roleUpdateFailed", {
            defaultValue: "Failed to update member role",
          }),
        ),
      );
    }
  };

  const handleConfirmRemove = async () => {
    if (!removeMemberId) return;
    const userId = removeMemberId;
    setRemoveMemberId(null);

    try {
      await removeMember.mutateAsync(userId);
      toast.success(
        t("cloud.membersTab.memberRemoved", {
          defaultValue: "Member removed",
        }),
      );
    } catch (error) {
      toast.error(
        organizationErrorMessage(
          error,
          t("cloud.membersTab.removeFailed", {
            defaultValue: "Failed to remove member",
          }),
        ),
      );
    }
  };

  return (
    <>
      <div className="space-y-4 md:space-y-6">
        {/* Header with Invite Button */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-base md:text-lg font-mono font-semibold text-white">
              {t("cloud.membersTab.title", { defaultValue: "Team Members" })}
            </h3>
            <p className="text-xs md:text-sm font-mono text-white/60">
              {t("cloud.membersTab.subtitle", {
                defaultValue: "Manage who has access to your organization",
              })}
            </p>
          </div>
          {canManageMembers && (
            <BrandButton
              type="button"
              variant="primary"
              onClick={() => setIsInviteDialogOpen(true)}
              className="font-mono text-sm md:text-base w-full sm:w-auto"
            >
              <UserPlus className="h-4 w-4" />
              {t("cloud.membersTab.inviteMember", {
                defaultValue: "Invite Member",
              })}
            </BrandButton>
          )}
        </div>

        {/* Members List */}
        {membersQuery.isLoading ? (
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
            onRemove={setRemoveMemberId}
          />
        )}

        {/* Pending Invites */}
        {canManageMembers && (
          <div className="pt-4 md:pt-6 border-t border-white/10">
            <h3 className="text-base md:text-lg font-mono font-semibold mb-3 md:mb-4 text-white">
              {t("cloud.membersTab.pendingInvitations", {
                defaultValue: "Pending Invitations",
              })}
            </h3>
            {invitesQuery.isLoading ? (
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
          organizationName={user.organization?.name ?? "this organization"}
        />
      </div>

      {/* Remove Member Confirmation */}
      <AlertDialog
        open={removeMemberId !== null}
        onOpenChange={(open) => !open && setRemoveMemberId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("cloud.membersTab.removeMemberTitle", {
                defaultValue: "Remove Member",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.membersTab.removeMemberConfirm", {
                defaultValue:
                  "Are you sure you want to remove this member? They will lose access to the organization.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("cloud.membersTab.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmRemove}
              className="bg-red-600 hover:bg-red-700"
            >
              {t("cloud.membersTab.remove", { defaultValue: "Remove" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
