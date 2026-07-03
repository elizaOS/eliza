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
  BrandButton,
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
import { Button } from "../../components/ui/button";
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
      <DialogContent className="bg-neutral-950 border border-brand-surface p-4 sm:p-6 max-w-[95vw] sm:max-w-md">
        {inviteLink ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white font-mono">
                <Link2 className="h-5 w-5 text-[#FF5800]" />
                Invitation Created
              </DialogTitle>
              <DialogDescription className="text-white/60 font-mono text-xs md:text-sm">
                The email is on its way — or share this link directly. It
                expires in 7 days and can be revoked from Pending Invitations.
                {connectIntent && (
                  <>
                    {" "}
                    After joining, they land on the Credentials tab ready to
                    connect their API key.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 flex items-center gap-2">
              <code className="flex-1 text-xs font-mono text-white break-all">
                {inviteLink}
              </code>
              <Button
                variant="ghost"
                type="button"
                onClick={handleCopyLink}
                aria-label="Copy invite link"
                className="p-2 hover:bg-white/5 transition-colors border border-white/10 flex-shrink-0"
              >
                <Copy className="h-4 w-4 text-white/60" />
              </Button>
            </div>
            <p className="text-xs font-mono text-white/40">
              The link contains no secrets — joining still requires signing in
              with the invited email.
            </p>

            <DialogFooter>
              <BrandButton
                type="button"
                variant="primary"
                onClick={handleClose}
                className="font-mono text-sm"
              >
                Done
              </BrandButton>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white font-mono">
                <Mail className="h-5 w-5 text-[#FF5800]" />
                Invite Team Member
              </DialogTitle>
              <DialogDescription className="text-white/60 font-mono text-xs md:text-sm">
                Send an invitation to join{" "}
                <span className="text-white">{organizationName}</span>.
                They&apos;ll receive an email with a link to accept. Accepting
                will switch them to{" "}
                <span className="text-white">{organizationName}</span> — a
                person belongs to one organization at a time, so they&apos;ll
                leave their current one.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="bg-[#EB4335]/10 border border-[#EB4335]/40 p-3 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-[#EB4335] flex-shrink-0 mt-0.5" />
                  <p className="text-xs md:text-sm font-mono text-[#EB4335]">
                    {error}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="email" className="text-white font-mono text-sm">
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
                  className="bg-transparent border-[#303030] text-white"
                />
                <p className="text-xs font-mono text-white/40">
                  They&apos;ll need to sign up with this email address
                </p>
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="role"
                  className="flex items-center gap-2 text-white font-mono text-sm"
                >
                  <UserCog className="h-4 w-4 text-[#FF5800]" />
                  Role
                </Label>
                <Select
                  value={role}
                  onValueChange={(value) => setRole(value as InviteRole)}
                  disabled={isSubmitting}
                >
                  <SelectTrigger
                    id="role"
                    className="bg-transparent border-[#303030] text-white"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1a1a1a] border-[#303030]">
                    <SelectItem value="member">
                      <div className="flex flex-col items-start">
                        <span className="font-mono font-medium text-white">
                          Member
                        </span>
                        <span className="text-xs font-mono text-white/40">
                          Can use resources and view organization
                        </span>
                      </div>
                    </SelectItem>
                    <SelectItem value="admin">
                      <div className="flex flex-col items-start">
                        <span className="font-mono font-medium text-white">
                          Admin
                        </span>
                        <span className="text-xs font-mono text-white/40">
                          Can invite and manage members
                        </span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <DialogFooter className="gap-2 sm:gap-0 flex flex-col sm:flex-row">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={handleClose}
                  disabled={isSubmitting}
                  className="px-4 py-2 text-white hover:bg-white/5 transition-colors disabled:opacity-50 order-2 sm:order-1"
                >
                  Cancel
                </Button>
                <BrandButton
                  type="submit"
                  variant="primary"
                  disabled={isSubmitting}
                  className="font-mono text-sm order-1 sm:order-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Mail className="h-4 w-4" />
                      Send Invitation
                    </>
                  )}
                </BrandButton>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
