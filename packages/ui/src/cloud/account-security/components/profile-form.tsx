/**
 * Profile form for updating user profile information: name, email add, and
 * read-only org role.
 *
 * Talks directly to the canonical profile routes via the typed cloud client:
 *   PATCH /api/v1/user        (name)
 *   PATCH /api/v1/user/email  (add email)
 *
 * Successful mutations reload the page so every shell/profile consumer observes
 * the updated identity without depending on cross-section query invalidation.
 */

import { Loader2, Mail, Shield, User } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  BrandButton,
  BrandCard,
  CornerBrackets,
  Input,
} from "../../../cloud-ui";
import { ApiError, apiFetch } from "../../lib/api-client";
import type { UserProfile } from "../data/user";

function mutationError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

interface ProfileActionResult {
  success: boolean;
  error?: string;
  message?: string;
}

interface ProfileMutationBody {
  success?: boolean;
  error?: string;
  reason?: string;
  message?: string;
}

async function updateProfile(formData: FormData): Promise<ProfileActionResult> {
  const name = String(formData.get("name") ?? "");

  try {
    const res = await apiFetch("/api/v1/user", {
      method: "PATCH",
      json: { name },
    });
    // error-policy:J3 an unparseable body maps to the explicit failure
    // result below, never a fake success.
    const body = (await res
      .json()
      // error-policy:J3 a non-JSON/empty body is an explicit "invalid" signal;
      // the `!body?.success` check below turns it into a user-facing error.
      .catch(() => null)) as ProfileMutationBody | null;
    if (!body?.success) {
      return {
        success: false,
        error: body?.error ?? "Failed to update profile",
      };
    }
    return {
      success: true,
      message: body.message ?? "Profile updated successfully",
    };
  } catch (err) {
    return {
      success: false,
      error: mutationError(err, "Failed to update profile"),
    };
  }
}

async function updateEmail(formData: FormData): Promise<ProfileActionResult> {
  const email = String(formData.get("email") ?? "");

  try {
    const res = await apiFetch("/api/v1/user/email", {
      method: "PATCH",
      json: { email },
    });
    // error-policy:J3 unparseable body maps to the explicit failure below.
    const body = (await res
      .json()
      // error-policy:J3 a non-JSON/empty body is an explicit "invalid" signal;
      // the `!body?.success` check below turns it into a user-facing error.
      .catch(() => null)) as ProfileMutationBody | null;
    if (!body?.success) {
      return { success: false, error: body?.error ?? "Failed to update email" };
    }
    return {
      success: true,
      message: body.message ?? "Email added successfully",
    };
  } catch (err) {
    return {
      success: false,
      error: mutationError(err, "Failed to update email"),
    };
  }
}

interface ProfileFormProps {
  user: UserProfile;
}

export function ProfileForm({ user }: ProfileFormProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isUpdatingEmail, setIsUpdatingEmail] = useState(false);
  const [emailAdded, setEmailAdded] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      const result = await updateProfile(formData);
      if (result.success) {
        setSuccess(result.message || "Profile updated successfully");
        toast.success(result.message || "Profile updated successfully");
        window.location.reload();
      } else {
        setError(result.error || "Failed to update profile");
        toast.error(result.error || "Failed to update profile");
      }
    });
  };

  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsUpdatingEmail(true);

    const formData = new FormData(e.currentTarget);
    const result = await updateEmail(formData);

    if (result.success) {
      setSuccess(result.message || "Email added successfully");
      toast.success(result.message || "Email added successfully");
      setEmailAdded(true);
      window.location.reload();
    } else {
      setError(result.error || "Failed to add email");
      toast.error(result.error || "Failed to add email");
    }
    setIsUpdatingEmail(false);
  };

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <User className="h-5 w-5 text-accent" />
            <h3 className="text-lg font-bold text-txt-strong">
              Profile Information
            </h3>
          </div>
          <p className="text-sm text-muted">
            Update your profile information and manage your account settings
          </p>
        </div>

        {!user.email && !emailAdded && (
          <div className="space-y-2 p-4 border border-accent-muted bg-accent-subtle rounded-sm">
            <div className="flex items-center gap-2 mb-3">
              <Mail className="h-4 w-4 text-accent" />
              <label
                htmlFor="new-email"
                className="text-xs font-medium text-accent uppercase tracking-wide"
              >
                Add Email Address
              </label>
            </div>
            <p className="text-xs text-muted mb-3">
              Adding an email allows you to receive important notifications and
              updates.
            </p>
            <form onSubmit={handleEmailSubmit} className="space-y-3">
              <Input
                id="new-email"
                name="email"
                type="email"
                placeholder="your@email.com"
                disabled={isUpdatingEmail}
                required
                className="min-h-touch rounded-sm border-input bg-bg-elevated text-txt placeholder:text-muted disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <BrandButton
                type="submit"
                variant="primary"
                size="sm"
                disabled={isUpdatingEmail}
                className="w-full"
              >
                {isUpdatingEmail ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin motion-reduce:animate-none" />
                    Adding Email...
                  </>
                ) : (
                  <>
                    <Mail className="h-4 w-4 mr-2" />
                    Add Email Address
                  </>
                )}
              </BrandButton>
            </form>
          </div>
        )}

        {user.email && (
          <div className="space-y-2">
            <label
              htmlFor="email"
              className="text-xs font-medium text-muted uppercase tracking-wide flex items-center gap-2"
            >
              <Mail className="h-4 w-4" />
              Email Address
            </label>
            <Input
              id="email"
              type="email"
              value={user.email}
              disabled
              className="min-h-touch rounded-sm border-border bg-bg-muted text-muted disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <p className="text-xs text-muted">
              Email cannot be changed. Please contact support if you need to
              update this.
            </p>
          </div>
        )}

        {emailAdded && !user.email && (
          <div className="space-y-2 p-4 border border-status-success bg-status-success-bg rounded-sm">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-status-success" />
              <p className="text-sm font-medium text-status-success">
                Email Added Successfully!
              </p>
            </div>
            <p className="text-xs text-muted">
              Your email has been added and will appear here after the page
              refreshes.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="name"
                className="text-xs font-medium text-muted uppercase tracking-wide"
              >
                Full Name <span className="text-accent">*</span>
              </label>
              <Input
                id="name"
                name="name"
                type="text"
                defaultValue={user.name || ""}
                placeholder="Enter your full name"
                required
                maxLength={100}
                disabled={isPending}
                className="min-h-touch rounded-sm border-input bg-bg-elevated text-txt placeholder:text-muted disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>

            {user.wallet_address && (
              <div className="space-y-2">
                <label
                  htmlFor="wallet-address"
                  className="text-xs font-medium text-muted uppercase tracking-wide flex items-center gap-2"
                >
                  <User className="h-4 w-4" />
                  Wallet Address
                </label>
                <Input
                  id="wallet-address"
                  type="text"
                  value={user.wallet_address}
                  disabled
                  className="min-h-touch rounded-sm border-border bg-bg-muted text-muted font-mono text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                />
                {user.wallet_chain_type && (
                  <p className="text-xs text-muted capitalize">
                    Connected via {user.wallet_chain_type} wallet
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <label
                htmlFor="user-role"
                className="text-xs font-medium text-muted uppercase tracking-wide flex items-center gap-2"
              >
                <Shield className="h-4 w-4" />
                Role
              </label>
              <Input
                id="user-role"
                type="text"
                value={user.role}
                disabled
                className="min-h-touch rounded-sm border-border bg-bg-muted text-muted capitalize disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <p className="text-xs text-muted">
                Your role in the organization. Contact an admin to change this.
              </p>
            </div>
          </div>

          {error && (
            <Alert
              variant="destructive"
              className="rounded-sm border-status-danger bg-status-danger-bg"
            >
              <AlertDescription className="text-status-danger">
                {error}
              </AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert className="rounded-sm border-status-success bg-status-success-bg">
              <AlertDescription className="text-status-success">
                {success}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-3 pt-4">
            <BrandButton type="submit" variant="primary" disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin motion-reduce:animate-none" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </BrandButton>
            <BrandButton
              type="button"
              variant="outline"
              onClick={() => window.location.reload()}
              disabled={isPending}
            >
              Cancel
            </BrandButton>
          </div>
        </form>
      </div>
    </BrandCard>
  );
}
