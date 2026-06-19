/**
 * Dialog component for inviting members to an organization.
 * Allows setting email and role (member or admin) with validation and error
 * handling.
 *
 * Ported from `@elizaos/cloud-frontend`; the raw `fetch()` POST is replaced by
 * the {@link useCreateInvite} React-Query mutation (typed client +
 * invalidation), and the copy now surfaces the single-org reality: accepting an
 * invite *moves* the invitee's organization (Eliza Cloud is single-membership),
 * so the invitee switches to this org rather than gaining a second membership.
 *
 * @param props - Invite member dialog configuration
 * @param props.isOpen - Whether dialog is open
 * @param props.onClose - Callback when dialog closes
 * @param props.onSuccess - Callback when invitation is successfully sent
 * @param props.organizationName - Name of the org the invitee will switch to
 */

import { AlertCircle, Loader2, Mail, UserCog } from "lucide-react";
import { useState } from "react";
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
}

export function InviteMemberDialog({
  isOpen,
  onClose,
  onSuccess,
  organizationName,
}: InviteMemberDialogProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [error, setError] = useState<string | null>(null);
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
      await createInvite.mutateAsync({ email, role });
      setEmail("");
      setRole("member");
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
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="bg-neutral-950 border border-brand-surface p-4 sm:p-6 max-w-[95vw] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white font-mono">
            <Mail className="h-5 w-5 text-[#FF5800]" />
            Invite Team Member
          </DialogTitle>
          <DialogDescription className="text-white/60 font-mono text-xs md:text-sm">
            Send an invitation to join{" "}
            <span className="text-white">{organizationName}</span>. They&apos;ll
            receive an email with a link to accept. Accepting will switch them
            to <span className="text-white">{organizationName}</span> — a person
            belongs to one organization at a time, so they&apos;ll leave their
            current one.
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
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-white hover:bg-white/5 transition-colors disabled:opacity-50 order-2 sm:order-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="relative bg-[#e1e1e1] px-4 py-2 overflow-hidden hover:bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed order-1 sm:order-2"
            >
              <div
                className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
                style={{
                  backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                  backgroundSize: "2.915576934814453px 2.915576934814453px",
                }}
              />
              <span className="relative z-10 text-black font-mono font-medium text-sm flex items-center justify-center gap-2">
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
              </span>
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
