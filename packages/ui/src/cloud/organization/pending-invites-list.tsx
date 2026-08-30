/**
 * Pending invites list component displaying organization invitation status.
 * Shows invite details, expiration, and supports invitation revocation.
 *
 * @param props - Pending invites list configuration
 * @param props.invites - Array of invitation objects
 * @param props.onRevoke - Callback when invitation is revoked
 */

import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2,
  Clock,
  Mail,
  Shield,
  User,
  X,
  XCircle,
} from "lucide-react";
import { useState } from "react";
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
} from "../../cloud-ui";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import type { OrgInviteDto } from "./data/cloud-org-types";

interface PendingInvitesListProps {
  invites: OrgInviteDto[];
  onRevoke: (inviteId: string) => void;
}

export function PendingInvitesList({
  invites,
  onRevoke,
}: PendingInvitesListProps) {
  const pendingInvites = invites.filter((i) => i.status === "pending");
  const [now] = useState(() => Date.now());

  if (pendingInvites.length === 0) {
    return (
      <Card variant="insetPadded" className="p-6 text-center">
        <Mail className="size-10 mx-auto text-muted mb-3" />
        <p className="text-sm font-mono text-muted">No pending invitations</p>
      </Card>
    );
  }

  const getRoleIcon = (role: string) => {
    switch (role) {
      case "admin":
        return <Shield className="size-3.5" />;
      default:
        return <User className="size-3.5" />;
    }
  };

  const getStatusBadge = (invite: OrgInviteDto) => {
    const nowDate = new Date();
    const expiresAt = new Date(invite.expires_at);

    if (invite.status === "pending" && nowDate > expiresAt) {
      return (
        <Badge
          variant="statusDanger"
          size="metaCompact"
          className="gap-1 font-mono"
        >
          <XCircle className="size-3" />
          Expired
        </Badge>
      );
    }

    switch (invite.status) {
      case "pending":
        return (
          <Badge
            variant="metaStrong"
            size="metaCompact"
            className="gap-1 font-mono"
          >
            <Clock className="size-3" />
            Pending
          </Badge>
        );
      case "accepted":
        return (
          <Badge
            variant="statusSuccess"
            size="metaCompact"
            className="gap-1 font-mono"
          >
            <CheckCircle2 className="size-3" />
            Accepted
          </Badge>
        );
      case "revoked":
        return (
          <Badge
            variant="statusMuted"
            size="metaCompact"
            className="gap-1 font-mono"
          >
            <XCircle className="size-3" />
            Revoked
          </Badge>
        );
      default:
        return (
          <Badge variant="metaDefault" size="metaCompact" className="font-mono">
            {invite.status}
          </Badge>
        );
    }
  };

  const getInviterName = (invite: OrgInviteDto) => {
    if (!invite.inviter) return "Unknown";
    return invite.inviter.name || invite.inviter.email || "Unknown";
  };

  return (
    <div className="space-y-3">
      {pendingInvites.map((invite) => {
        const expiresAt = new Date(invite.expires_at);
        const isExpiringSoon = expiresAt.getTime() - now < 24 * 60 * 60 * 1000;

        return (
          <Card key={invite.id} variant="insetPadded" className="md:p-4">
            <div className="flex flex-col sm:flex-row items-start justify-between gap-3 sm:gap-4">
              <div className="flex-1 min-w-0 w-full space-y-2">
                {/* Email */}
                <div className="flex items-center gap-2">
                  <Mail className="size-4 text-muted shrink-0" />
                  <span className="font-mono font-medium text-sm md:text-base text-txt-strong truncate">
                    {invite.email}
                  </span>
                </div>

                {/* Role */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant="metaDefault"
                    size="metaCompact"
                    className="gap-1 font-mono"
                  >
                    {getRoleIcon(invite.role)}
                    <span className="capitalize">{invite.role}</span>
                  </Badge>
                  {getStatusBadge(invite)}
                </div>

                {/* Metadata */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 text-xs font-mono text-muted">
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
                  <div className="flex items-center gap-1.5 text-xs font-mono text-txt-strong">
                    <Clock className="size-3.5" />
                    <span>
                      Expires{" "}
                      {formatDistanceToNow(expiresAt, { addSuffix: true })}
                    </span>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="dangerGhost"
                      size="icon-sm"
                      type="button"
                      aria-label={`Revoke invitation for ${invite.email}`}
                    >
                      <X className="size-4 text-danger" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="text-txt-strong font-mono">
                        Revoke Invitation
                      </AlertDialogTitle>
                      <AlertDialogDescription className="text-muted font-mono text-sm">
                        Are you sure you want to revoke the invitation for{" "}
                        <span className="font-medium text-txt-strong">
                          {invite.email}
                        </span>
                        ? They will not be able to join using this invitation
                        link.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <Button asChild variant="destructive">
                        <AlertDialogAction onClick={() => onRevoke(invite.id)}>
                          Revoke
                        </AlertDialogAction>
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </Card>
        );
      })}

      {/* Show revoked/accepted invites */}
      {invites.filter((i) => i.status !== "pending").length > 0 && (
        <details className="mt-4 md:mt-6">
          <Button asChild variant="ghostMuted" size="sm">
            <summary className="font-mono">
              Show past invitations (
              {invites.filter((i) => i.status !== "pending").length})
            </summary>
          </Button>
          <div className="space-y-3 mt-3">
            {invites
              .filter((i) => i.status !== "pending")
              .map((invite) => (
                <Card
                  key={invite.id}
                  variant="insetPadded"
                  className="md:p-4 opacity-60"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2">
                        <Mail className="size-4 text-muted shrink-0" />
                        <span className="font-mono font-medium text-sm text-txt-strong truncate">
                          {invite.email}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge
                          variant="metaDefault"
                          size="metaCompact"
                          className="gap-1 font-mono"
                        >
                          {getRoleIcon(invite.role)}
                          <span className="capitalize">{invite.role}</span>
                        </Badge>
                        {getStatusBadge(invite)}
                      </div>
                      <div className="text-xs font-mono text-muted">
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
                </Card>
              ))}
          </div>
        </details>
      )}
    </div>
  );
}
