/**
 * Dialog component for inviting members to an organization.
 * Allows setting email and role (member or admin) with validation and error
 * handling.
 *
 * After the invite is created the dialog shows the copyable invite link
 * (`/invite/accept?token=…`) so the owner can DM it instead of relying on the
 * email. With `connectIntent` (the Credentials tab "Invite & Connect" flow,
 * #11332 design §5) the link carries `connect=1`, which routes the teammate to
 * the Credentials tab with the contribute modal open right after joining. The
 * link carries only the expiring hashed-token invite — no secrets.
 *
 * @param props - Invite member dialog configuration
 * @param props.isOpen - Whether dialog is open
 * @param props.onClose - Callback when dialog closes
 * @param props.onSuccess - Callback when invitation is successfully created
 * @param props.organizationName - Name of the org the invitee will switch to
 * @param props.connectIntent - Append `connect=1` to the invite link
 */

import { AlertCircle, Copy, Link2, Loader2, Mail, UserCog } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../cloud-ui";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { SemanticForm } from "../../components/ui/semantic-form";
import { copyTextToClipboard } from "../../utils/clipboard";
import type { InviteRole } from "./data/cloud-org-types";
import {
  organizationErrorMessage,
  useCreateInvite,
} from "./data/use-organization";

interface InviteMemberDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  organizationName: string;
  connectIntent?: boolean;
}

/** Build the shareable accept URL from the one-time invite token. */
export function buildInviteLink(token: string, connect: boolean): string {
  const url = new URL("/invite/accept", window.location.origin);
  url.searchParams.set("token", token);
  if (connect) url.searchParams.set("connect", "1");
  return url.toString();
}

export function InviteMemberDialog({
  isOpen,
  onClose,
  onSuccess,
  organizationName,
  connectIntent = false,
}: InviteMemberDialogProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const createInvite = useCreateInvite();
  const isSubmitting = createInvite.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email?.includes("@")) {
      setError("Please enter a valid email address");
      return;
    }

    try {
      const created = await createInvite.mutateAsync({ email, role });
      setEmail("");
      setRole("member");
      setInviteLink(
        created?.token ? buildInviteLink(created.token, connectIntent) : null,
      );
      onSuccess();
    } catch (err) {
      setError(organizationErrorMessage(err, "Failed to send invitation"));
    }
  };

  const handleClose = () => {
    if (!isSubmitting) {
      setEmail("");
      setRole("member");
      setError(null);
      setInviteLink(null);
      onClose();
    }
  };

  const handleCopyLink = async () => {
    if (!inviteLink) return;
    try {
      await copyTextToClipboard(inviteLink);
      toast.success("Invite link copied to clipboard");
    } catch {
      toast.error("Failed to copy invite link");
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="p-4 sm:p-6 max-w-[95vw] sm:max-w-md">
        {inviteLink ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-txt-strong font-mono">
                <Link2 className="size-5 text-muted" />
                Invitation Created
              </DialogTitle>
              <DialogDescription className="text-muted font-mono text-xs md:text-sm">
                The email is on its way, or share this link directly. It expires
                in 7 days and can be revoked from Pending Invitations.
                {connectIntent && (
                  <>
                    {" "}
                    After joining, they land on the Credentials tab ready to
                    connect their API key.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            <Card variant="insetPadded" flow="row" gap="compact">
              <code className="flex-1 text-xs font-mono text-txt-strong break-all">
                {inviteLink}
              </code>
              <Button
                variant="outlineMuted"
                size="icon-sm"
                type="button"
                onClick={handleCopyLink}
                aria-label="Copy invite link"
                className="shrink-0"
              >
                <Copy className="size-4 text-muted" />
              </Button>
            </Card>
            <p className="text-xs font-mono text-muted">
              The link contains no secrets. Joining still requires signing in
              with the invited email.
            </p>

            <DialogFooter>
              <Button
                type="button"
                variant="default"
                onClick={handleClose}
                className="font-mono text-sm"
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-txt-strong font-mono">
                <Mail className="size-5 text-muted" />
                Invite Team Member
              </DialogTitle>
              <DialogDescription className="text-muted font-mono text-xs md:text-sm">
                Send an invitation to join{" "}
                <span className="text-txt-strong">{organizationName}</span>.
                They&apos;ll receive an email with a link to accept. Accepting
                will switch them to{" "}
                <span className="text-txt-strong">{organizationName}</span> — a
                person belongs to one organization at a time, so they&apos;ll
                leave their current one.
              </DialogDescription>
            </DialogHeader>

            <SemanticForm onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <Alert variant="dashboardError" className="flex p-3">
                  <AlertCircle className="size-4 text-danger shrink-0 mt-0.5" />
                  <p className="text-xs md:text-sm font-mono text-danger">
                    {error}
                  </p>
                </Alert>
              )}

              <div className="space-y-2">
                <Label
                  htmlFor="email"
                  className="text-txt-strong font-mono text-sm"
                >
                  Email Address
                </Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="colleague@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={isSubmitting}
                  required
                  autoFocus
                  variant="form"
                />
                <p className="text-xs font-mono text-muted">
                  They&apos;ll need to sign up with this email address
                </p>
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="role"
                  className="flex items-center gap-2 text-txt-strong font-mono text-sm"
                >
                  <UserCog className="size-4 text-muted" />
                  Role
                </Label>
                <Select
                  value={role}
                  onValueChange={(value) => setRole(value as InviteRole)}
                  disabled={isSubmitting}
                >
                  <SelectTrigger id="role" variant="form">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent variant="form">
                    <SelectItem value="member">
                      <div className="flex flex-col items-start">
                        <span className="font-mono font-medium text-txt-strong">
                          Member
                        </span>
                        <span className="text-xs font-mono text-muted">
                          Can use resources and view organization
                        </span>
                      </div>
                    </SelectItem>
                    <SelectItem value="admin">
                      <div className="flex flex-col items-start">
                        <span className="font-mono font-medium text-txt-strong">
                          Admin
                        </span>
                        <span className="text-xs font-mono text-muted">
                          Can invite and manage members
                        </span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <DialogFooter className="gap-2 sm:gap-0 flex flex-col sm:flex-row">
                <Button
                  variant="ghostMuted"
                  type="button"
                  onClick={handleClose}
                  disabled={isSubmitting}
                  className="order-2 sm:order-1"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="default"
                  disabled={isSubmitting}
                  className="font-mono text-sm order-1 sm:order-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Sending…
                    </>
                  ) : (
                    <>
                      <Mail className="size-4" />
                      Send Invitation
                    </>
                  )}
                </Button>
              </DialogFooter>
            </SemanticForm>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
