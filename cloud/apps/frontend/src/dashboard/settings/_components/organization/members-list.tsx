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

"use client";

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
} from "@elizaos/cloud-ui";
import { format } from "date-fns";
import { Crown, Mail, Shield, User, UserMinus, Wallet } from "lucide-react";

interface Member {
  id: string;
  name: string | null;
  email: string | null;
  wallet_address: string | null;
  wallet_chain_type: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
}

interface MembersListProps {
  members: Member[];
  currentUserId: string;
  currentUserRole: string;
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
  if (members.length === 0) {
    return (
      <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-8 text-center">
        <User className="h-12 w-12 mx-auto text-white/40 mb-4" />
        <p className="text-sm font-mono text-white/60">No members found</p>
      </div>
    );
  }

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "owner":
        return <Crown className="h-4 w-4" />;
      case "admin":
        return <Shield className="h-4 w-4" />;
      default:
        return <User className="h-4 w-4" />;
    }
  };

  const _getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "owner":
        return "default";
      case "admin":
        return "secondary";
      default:
        return "outline";
    }
  };

  const getInitials = (member: Member) => {
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

  const getDisplayName = (member: Member) => {
    if (member.name) return member.name;
    if (member.email) return member.email;
    if (member.wallet_address) {
      return `${member.wallet_address.substring(0, 6)}...${member.wallet_address.substring(member.wallet_address.length - 4)}`;
    }
    return "Unknown";
  };

  const canUpdateRole = (member: Member) => {
    return isOwner && member.id !== currentUserId && member.role !== "owner";
  };

  const canRemove = (member: Member) => {
    if (member.id === currentUserId) return false;
    if (member.role === "owner") return false;
    if (currentUserRole === "owner") return true;
    if (currentUserRole === "admin" && member.role !== "admin") return true;
    return false;
  };

  return (
    <div className="space-y-3">
      {members.map((member) => (
        <div
          key={member.id}
          className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4"
        >
          <div className="flex flex-col sm:flex-row items-start gap-4">
            {/* Avatar */}
            <div className="flex items-center justify-center bg-[rgba(255,88,0,0.25)] size-10 md:size-12 flex-shrink-0">
              <span className="text-white text-sm md:text-base font-mono font-medium">
                {getInitials(member)}
              </span>
            </div>

            {/* Member Info */}
            <div className="flex-1 min-w-0 w-full">
              <div className="flex flex-col lg:flex-row items-start justify-between gap-3 lg:gap-4">
                <div className="flex-1 min-w-0 w-full">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h4 className="font-mono font-semibold text-sm md:text-base text-white truncate">
                      {getDisplayName(member)}
                    </h4>
                    {member.id === currentUserId && (
                      <span className="px-2 py-0.5 border border-white/20 text-xs font-mono text-white/60">
                        You
                      </span>
                    )}
                  </div>

                  <div className="space-y-1">
                    {member.email && (
                      <p className="text-xs md:text-sm font-mono text-white/60 flex items-center gap-1.5">
                        <Mail className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="truncate">{member.email}</span>
                      </p>
                    )}
                    {member.wallet_address && (
                      <p className="text-xs md:text-sm font-mono text-white/60 flex items-center gap-1.5 flex-wrap">
                        <Wallet className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="font-mono text-xs break-all">
                          {member.wallet_address.substring(0, 10)}...
                          {member.wallet_address.substring(member.wallet_address.length - 8)}
                        </span>
                        {member.wallet_chain_type && (
                          <span className="px-2 py-0.5 border border-white/20 text-xs font-mono text-white/60">
                            {member.wallet_chain_type}
                          </span>
                        )}
                      </p>
                    )}
                    <p className="text-xs font-mono text-white/40">
                      Member since {format(new Date(member.created_at), "MMM d, yyyy")}
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
                      <SelectTrigger className="w-full sm:w-32 bg-transparent border-[#303030] text-white">
                        <SelectValue>
                          <div className="flex items-center gap-1.5">
                            {getRoleIcon(member.role)}
                            <span className="capitalize font-mono text-xs md:text-sm">
                              {member.role}
                            </span>
                          </div>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent className="bg-[#1a1a1a] border-[#303030]">
                        <SelectItem value="admin">
                          <div className="flex items-center gap-1.5">
                            <Shield className="h-4 w-4" />
                            <span className="font-mono">Admin</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="member">
                          <div className="flex items-center gap-1.5">
                            <User className="h-4 w-4" />
                            <span className="font-mono">Member</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span
                      className={`px-2 py-1 border text-xs font-mono uppercase flex items-center gap-1.5 ${member.role === "owner" ? "bg-[#FF5800]/20 text-[#FF5800] border-[#FF5800]/40" : member.role === "admin" ? "bg-white/10 text-white border-white/20" : "bg-white/5 text-white/60 border-white/10"}`}
                    >
                      {getRoleIcon(member.role)}
                      <span className="capitalize">{member.role}</span>
                    </span>
                  )}

                  {canRemove(member) && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          type="button"
                          className="p-2 hover:bg-white/5 transition-colors border border-white/10"
                        >
                          <UserMinus className="h-4 w-4 text-[#EB4335]" />
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="bg-neutral-950 border border-brand-surface">
                        <AlertDialogHeader>
                          <AlertDialogTitle className="text-white font-mono">
                            Remove Member
                          </AlertDialogTitle>
                          <AlertDialogDescription className="text-white/60 font-mono text-sm">
                            Are you sure you want to remove {getDisplayName(member)} from the
                            organization? They will lose access to all resources.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="bg-transparent border-[#303030] text-white hover:bg-white/5">
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => onRemove(member.id)}
                            className="bg-[#EB4335] hover:bg-[#EB4335]/90 text-white"
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
