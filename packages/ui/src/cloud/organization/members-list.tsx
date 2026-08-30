/**
 * Members list component displaying organization members with role management.
 * Supports role updates and member removal with permission checks.
 *
 * @param props - Members list configuration
 * @param props.members - Array of member objects
 * @param props.currentUserId - Current user's ID
 * @param props.currentUserRole - Current user's role
 * @param props.isOwner - Whether current user is organization owner
 * @param props.onUpdateRole - Callback when member role is updated
 * @param props.onRemove - Callback when member is removed
 */

import { format } from "date-fns";
import { Crown, Mail, Shield, User, UserMinus, Wallet } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../cloud-ui";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  canManageOrg,
  isOrgOwner,
  type OrgMemberDto,
  type OrgRole,
  orgRoleRank,
} from "./data/cloud-org-types";

interface MembersListProps {
  members: OrgMemberDto[];
  currentUserId: string;
  currentUserRole: OrgRole;
  isOwner: boolean;
  onUpdateRole: (userId: string, role: string) => void;
  onRemove: (userId: string) => void;
}

export function MembersList({
  members,
  currentUserId,
  currentUserRole,
  isOwner,
  onUpdateRole,
  onRemove,
}: MembersListProps) {
  const t = useCloudT();
  if (members.length === 0) {
    return (
      <Card variant="insetPadded" className="p-8 text-center">
        <User className="size-12 mx-auto text-muted mb-4" />
        <p className="text-sm font-mono text-muted">
          {t("cloud.membersList.noMembers", {
            defaultValue: "No members found",
          })}
        </p>
      </Card>
    );
  }

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "owner":
        return <Crown className="size-4" />;
      case "admin":
        return <Shield className="size-4" />;
      default:
        return <User className="size-4" />;
    }
  };

  const getInitials = (member: OrgMemberDto) => {
    if (member.name) {
      return member.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .substring(0, 2);
    }
    if (member.email) {
      return member.email.substring(0, 2).toUpperCase();
    }
    if (member.wallet_address) {
      return member.wallet_address.substring(2, 4).toUpperCase();
    }
    return "??";
  };

  const getDisplayName = (member: OrgMemberDto) => {
    if (member.name) return member.name;
    if (member.email) return member.email;
    if (member.wallet_address) {
      return `${member.wallet_address.substring(0, 6)}...${member.wallet_address.substring(member.wallet_address.length - 4)}`;
    }
    return t("cloud.membersList.unknown", { defaultValue: "Unknown" });
  };

  const canUpdateRole = (member: OrgMemberDto) => {
    return isOwner && member.id !== currentUserId && !isOrgOwner(member.role);
  };

  const canRemove = (member: OrgMemberDto) => {
    if (member.id === currentUserId) return false;
    if (isOrgOwner(member.role)) return false;
    // A manager (admin/owner) may remove anyone strictly below their own tier:
    // an owner removes admins + members; an admin removes only members.
    return (
      canManageOrg(currentUserRole) &&
      orgRoleRank(currentUserRole) > orgRoleRank(member.role)
    );
  };

  return (
    <div className="space-y-3">
      {members.map((member) => (
        <Card key={member.id} variant="insetPadded" className="md:p-4">
          <div className="flex flex-col sm:flex-row items-start gap-4">
            {/* Avatar */}
            <Card
              variant="sidebarIcon"
              flow="row"
              className="size-10 shrink-0 justify-center md:size-12"
            >
              <span className="text-txt-strong text-sm md:text-base font-mono font-medium">
                {getInitials(member)}
              </span>
            </Card>

            {/* Member Info */}
            <div className="flex-1 min-w-0 w-full">
              <div className="flex flex-col lg:flex-row items-start justify-between gap-3 lg:gap-4">
                <div className="flex-1 min-w-0 w-full">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h4 className="font-mono font-semibold text-sm md:text-base text-txt-strong truncate">
                      {getDisplayName(member)}
                    </h4>
                    {member.id === currentUserId && (
                      <Badge
                        variant="metaDefault"
                        size="metaCompact"
                        className="font-mono"
                      >
                        {t("cloud.membersList.you", { defaultValue: "You" })}
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-1">
                    {member.email && (
                      <p className="text-xs md:text-sm font-mono text-muted flex items-center gap-1.5">
                        <Mail className="size-3.5 shrink-0" />
                        <span className="truncate">{member.email}</span>
                      </p>
                    )}
                    {member.wallet_address && (
                      <p className="text-xs md:text-sm font-mono text-muted flex items-center gap-1.5 flex-wrap">
                        <Wallet className="size-3.5 shrink-0" />
                        <span className="font-mono text-xs break-all">
                          {member.wallet_address.substring(0, 10)}...
                          {member.wallet_address.substring(
                            member.wallet_address.length - 8,
                          )}
                        </span>
                        {member.wallet_chain_type && (
                          <Badge
                            variant="metaDefault"
                            size="metaCompact"
                            className="font-mono"
                          >
                            {member.wallet_chain_type}
                          </Badge>
                        )}
                      </p>
                    )}
                    <p className="text-xs font-mono text-muted">
                      {t("cloud.membersList.memberSince", {
                        date: format(
                          new Date(member.created_at),
                          "MMM d, yyyy",
                        ),
                        defaultValue: "Member since {{date}}",
                      })}
                    </p>
                  </div>
                </div>

                {/* Role Badge and Actions */}
                <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                  {canUpdateRole(member) ? (
                    <Select
                      value={member.role}
                      onValueChange={(role) => onUpdateRole(member.id, role)}
                    >
                      <SelectTrigger variant="form" className="w-full sm:w-32">
                        <SelectValue>
                          <div className="flex items-center gap-1.5">
                            {getRoleIcon(member.role)}
                            <span className="capitalize font-mono text-xs md:text-sm">
                              {member.role}
                            </span>
                          </div>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent variant="form">
                        <SelectItem value="admin">
                          <div className="flex items-center gap-1.5">
                            <Shield className="size-4" />
                            <span className="font-mono">
                              {t("cloud.membersList.admin", {
                                defaultValue: "Admin",
                              })}
                            </span>
                          </div>
                        </SelectItem>
                        <SelectItem value="member">
                          <div className="flex items-center gap-1.5">
                            <User className="size-4" />
                            <span className="font-mono">
                              {t("cloud.membersList.member", {
                                defaultValue: "Member",
                              })}
                            </span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge
                      variant={
                        member.role === "owner" ? "metaStrong" : "metaDefault"
                      }
                      size="metaCompact"
                      className="gap-1.5 font-mono uppercase"
                    >
                      {getRoleIcon(member.role)}
                      <span className="capitalize">{member.role}</span>
                    </Badge>
                  )}

                  {canRemove(member) && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="dangerGhost"
                          size="icon-sm"
                          type="button"
                          aria-label={t("cloud.membersList.removeMember", {
                            defaultValue: "Remove Member",
                          })}
                        >
                          <UserMinus className="size-4 text-danger" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle className="text-txt-strong font-mono">
                            {t("cloud.membersList.removeMember", {
                              defaultValue: "Remove Member",
                            })}
                          </AlertDialogTitle>
                          <AlertDialogDescription className="text-muted font-mono text-sm">
                            {t("cloud.membersList.removeConfirm", {
                              name: getDisplayName(member),
                              defaultValue:
                                "Are you sure you want to remove {{name}} from the organization? They will lose access to all resources.",
                            })}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>
                            {t("cloud.membersList.cancel", {
                              defaultValue: "Cancel",
                            })}
                          </AlertDialogCancel>
                          <Button asChild variant="destructive">
                            <AlertDialogAction
                              onClick={() => onRemove(member.id)}
                            >
                              {t("cloud.membersList.remove", {
                                defaultValue: "Remove",
                              })}
                            </AlertDialogAction>
                          </Button>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
