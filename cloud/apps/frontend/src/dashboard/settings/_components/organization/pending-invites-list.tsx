/**
 * Pending invites list component displaying organization invitation status.
 * Shows invite details, expiration, and supports invitation revocation.
 *
 * @param props - Pending invites list configuration
 * @param props.invites - Array of invitation objects
 * @param props.onRevoke - Callback when invitation is revoked
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
} from "@elizaos/cloud-ui";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, Clock, Mail, Shield, User, X, XCircle } from "lucide-react";
import { useState } from "react";

interface Invite {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  created_at: string;
  inviter: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
  accepted_at: string | null;
}

interface PendingInvitesListProps {
  invites: Invite[];
  onRevoke: (inviteId: string) => void;
}

export function PendingInvitesList({ invites, onRevoke }: PendingInvitesListProps) {
  const pendingInvites = invites.filter((i) => i.status === "pending");
  const [now] = useState(() => Date.now());

  if (pendingInvites.length === 0) {
    return (
      <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-6 text-center">
        <Mail className="h-10 w-10 mx-auto text-white/40 mb-3" />
        <p className="text-sm font-mono text-white/60">No pending invitations</p>
      </div>
    );
  }

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "admin":
        return <Shield className="h-3.5 w-3.5" />;
      default:
        return <User className="h-3.5 w-3.5" />;
    }
  };

  const getStatusBadge = (invite: Invite) => {
    const now = new Date();
    const expiresAt = new Date(invite.expires_at);

    if (invite.status === "pending" && now > expiresAt) {
      return (
        <span className="px-2 py-0.5 border border-[#EB4335]/40 bg-[#EB4335]/20 text-[#EB4335] flex items-center gap-1 text-xs font-mono">
          <XCircle className="h-3 w-3" />
          Expired
        </span>
      );
    }

    switch (invite.status) {
      case "pending":
        return (
          <span className="px-2 py-0.5 border border-white/20 bg-white/10 text-white flex items-center gap-1 text-xs font-mono">
            <Clock className="h-3 w-3" />
            Pending
          </span>
        );
      case "accepted":
        return (
          <span className="px-2 py-0.5 border border-green-500/40 bg-green-500/20 text-green-400 flex items-center gap-1 text-xs font-mono">
            <CheckCircle2 className="h-3 w-3" />
            Accepted
          </span>
        );
      case "revoked":
        return (
          <span className="px-2 py-0.5 border border-white/10 bg-white/5 text-white/40 flex items-center gap-1 text-xs font-mono">
            <XCircle className="h-3 w-3" />
            Revoked
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 border border-white/10 text-xs font-mono text-white/60">
            {invite.status}
          </span>
        );
    }
  };

  const getInviterName = (invite: Invite) => {
    if (!invite.inviter) return "Unknown";
    return invite.inviter.name || invite.inviter.email || "Unknown";
  };

  return (
    <div className="space-y-3">
      {pendingInvites.map((invite) => {
        const expiresAt = new Date(invite.expires_at);
        const isExpiringSoon = expiresAt.getTime() - now < 24 * 60 * 60 * 1000;

        return (
          <div
            key={invite.id}
            className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4"
          >
            <div className="flex flex-col sm:flex-row items-start justify-between gap-3 sm:gap-4">
              <div className="flex-1 min-w-0 w-full space-y-2">
                {/* Email */}
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-white/40 flex-shrink-0" />
                  <span className="font-mono font-medium text-sm md:text-base text-white truncate">
                    {invite.email}
                  </span>
                </div>

                {/* Role */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="px-2 py-0.5 border border-white/20 text-xs font-mono text-white/60 flex items-center gap-1">
                    {getRoleIcon(invite.role)}
                    <span className="capitalize">{invite.role}</span>
                  </span>
                  {getStatusBadge(invite)}
                </div>

                {/* Metadata */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 text-xs font-mono text-white/40">
                  <span>Invited by {getInviterName(invite)}</span>
                  <span className="hidden sm:inline">•</span>
                  <span>
                    {formatDistanceToNow(new Date(invite.created_at), {
                      addSuffix: true,
                    })}
                  </span>
                </div>

                {/* Expiration Warning */}
                {isExpiringSoon && (
                  <div className="flex items-center gap-1.5 text-xs font-mono text-[#FF5800]">
                    <Clock className="h-3.5 w-3.5" />
                    <span>Expires {formatDistanceToNow(expiresAt, { addSuffix: true })}</span>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
                      className="p-2 hover:bg-white/5 transition-colors border border-white/10"
                    >
                      <X className="h-4 w-4 text-[#EB4335]" />
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="bg-neutral-950 border border-brand-surface">
                    <AlertDialogHeader>
                      <AlertDialogTitle className="text-white font-mono">
                        Revoke Invitation
                      </AlertDialogTitle>
                      <AlertDialogDescription className="text-white/60 font-mono text-sm">
                        Are you sure you want to revoke the invitation for{" "}
                        <span className="font-medium text-white">{invite.email}</span>? They will
                        not be able to join using this invitation link.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="bg-transparent border-[#303030] text-white hover:bg-white/5">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => onRevoke(invite.id)}
                        className="bg-[#EB4335] hover:bg-[#EB4335]/90 text-white"
                      >
                        Revoke
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>
        );
      })}

      {/* Show revoked/accepted invites */}
      {invites.filter((i) => i.status !== "pending").length > 0 && (
        <details className="mt-4 md:mt-6">
          <summary className="cursor-pointer text-xs md:text-sm font-mono text-white/60 hover:text-white transition-colors">
            Show past invitations ({invites.filter((i) => i.status !== "pending").length})
          </summary>
          <div className="space-y-3 mt-3">
            {invites
              .filter((i) => i.status !== "pending")
              .map((invite) => (
                <div
                  key={invite.id}
                  className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4 opacity-60"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-white/40 flex-shrink-0" />
                        <span className="font-mono font-medium text-sm text-white truncate">
                          {invite.email}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2 py-0.5 border border-white/20 text-xs font-mono text-white/60 flex items-center gap-1">
                          {getRoleIcon(invite.role)}
                          <span className="capitalize">{invite.role}</span>
                        </span>
                        {getStatusBadge(invite)}
                      </div>
                      <div className="text-xs font-mono text-white/40">
                        {invite.status === "accepted" && invite.accepted_at && (
                          <span>
                            Accepted{" "}
                            {formatDistanceToNow(new Date(invite.accepted_at), {
                              addSuffix: true,
                            })}
                          </span>
                        )}
                        {invite.status === "revoked" && <span>Revoked</span>}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}
