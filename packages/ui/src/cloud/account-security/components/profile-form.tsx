/**
 * Profile editor for the signed-in user's name and optional first email.
 *
 * Talks directly to the canonical profile routes via the typed cloud client:
 *   PATCH /api/v1/user        (name)
 *   PATCH /api/v1/user/email  (add email)
 *
 * Successful mutations reload the page so every shell/profile consumer observes
 * the updated identity without depending on cross-section query invalidation.
 * Email is add-once: a present address is shown disabled. The labelled 1:1
 * fields compose SettingsStack / SettingsGroup / SettingsInputRow.
 */

import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  SettingsActionButton,
  SettingsInputRow,
} from "../../../components/settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { SemanticForm } from "../../../components/ui/semantic-form";
import { ApiError, apiFetch } from "../../lib/api-client";
import type { UserProfile } from "../data/user";

const NAME_MAX_LENGTH = 100;

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

async function updateProfile(name: string): Promise<ProfileActionResult> {
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

async function updateEmail(email: string): Promise<ProfileActionResult> {
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
  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState("");

  const submitName = () => {
    setError(null);
    setSuccess(null);
    const nextName = name.trim();
    if (!nextName) {
      setError("Enter your full name.");
      return;
    }

    startTransition(async () => {
      const result = await updateProfile(nextName);
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

  const submitEmail = async () => {
    setError(null);
    setSuccess(null);
    const nextEmail = email.trim();
    if (!nextEmail) {
      setError("Enter an email address.");
      return;
    }

    setIsUpdatingEmail(true);
    const result = await updateEmail(nextEmail);

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
    <SettingsStack data-testid="cloud-profile-form">
      <SettingsGroup
        title="Profile information"
        description="Update your profile information and manage your account settings."
      >
        {!user.email && !emailAdded ? (
          <SemanticForm
            onSubmit={(event) => {
              event.preventDefault();
              void submitEmail();
            }}
          >
            <SettingsInputRow
              agentId="profile-email"
              agentLabel="Email address"
              group="profile"
              label="Email address"
              description="Adding an email lets you receive important notifications and updates."
              type="email"
              value={email}
              onValueChange={setEmail}
              placeholder="your@email.com"
              autoComplete="email"
              disabled={isUpdatingEmail}
              testId="profile-email-input"
            />
            <div className="flex items-center gap-3 pt-1">
              <SettingsActionButton
                agentId="profile-add-email"
                agentLabel="Add email address"
                agentGroup="profile"
                agentStatus={isUpdatingEmail ? "loading" : undefined}
                type="submit"
                disabled={isUpdatingEmail}
                data-testid="profile-add-email"
              >
                {isUpdatingEmail ? (
                  <>
                    <Loader2
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                    Adding email…
                  </>
                ) : (
                  "Add email address"
                )}
              </SettingsActionButton>
            </div>
          </SemanticForm>
        ) : null}

        {user.email ? (
          <SettingsInputRow
            agentId="profile-email"
            agentLabel="Email address"
            group="profile"
            label="Email address"
            description="Email cannot be changed. Contact support if you need to update this."
            type="email"
            value={user.email}
            onValueChange={() => undefined}
            autoComplete="email"
            disabled
            testId="profile-email-input"
          />
        ) : null}

        {emailAdded && !user.email ? (
          <Alert>
            <AlertDescription>
              Email added successfully. It will appear here after the page
              refreshes.
            </AlertDescription>
          </Alert>
        ) : null}

        <SemanticForm
          onSubmit={(event) => {
            event.preventDefault();
            submitName();
          }}
        >
          <SettingsInputRow
            agentId="profile-name"
            agentLabel="Full name"
            group="profile"
            label="Full name"
            type="text"
            value={name}
            onValueChange={(value) => setName(value.slice(0, NAME_MAX_LENGTH))}
            placeholder="Enter your full name"
            autoComplete="name"
            disabled={isPending}
            testId="profile-name-input"
          />

          {error ? (
            <div className="mt-2">
              <Alert variant="destructive" data-testid="profile-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          ) : null}

          {success ? (
            <div className="mt-2">
              <Alert data-testid="profile-success">
                <AlertDescription>{success}</AlertDescription>
              </Alert>
            </div>
          ) : null}

          <div className="flex items-center gap-3 pt-3">
            <SettingsActionButton
              agentId="profile-save"
              agentLabel="Save changes"
              agentGroup="profile"
              agentStatus={isPending ? "loading" : undefined}
              type="submit"
              disabled={isPending}
              data-testid="profile-save"
            >
              {isPending ? (
                <>
                  <Loader2
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                  Saving…
                </>
              ) : (
                "Save changes"
              )}
            </SettingsActionButton>
            <SettingsActionButton
              agentId="profile-cancel"
              agentLabel="Cancel"
              agentGroup="profile"
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => window.location.reload()}
              data-testid="profile-cancel"
            >
              Cancel
            </SettingsActionButton>
          </div>
        </SemanticForm>
      </SettingsGroup>
    </SettingsStack>
  );
}
