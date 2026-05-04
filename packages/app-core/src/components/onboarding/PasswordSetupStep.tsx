/**
 * PasswordSetupStep — onboarding wizard step for first-run password creation.
 *
 * Local installs: this step is REQUIRED (no skip).
 * Cloud-provisioned installs: this step is OPTIONAL (clearly worded fallback
 * warning so the user understands what skipping means).
 *
 * On submit calls POST /api/auth/setup. Server sets HttpOnly session cookies.
 *
 * Uses onboarding-form-primitives + onboarding-step-chrome exclusively —
 * no external component libraries.
 */

import { cn } from "@elizaos/ui";
import { useCallback, useId, useState } from "react";
import { type AuthSetupResult, authSetup } from "../../api/auth-client";
import {
  OnboardingField,
  OnboardingStatusBanner,
  onboardingDetailStackClassName,
  onboardingHelperTextClassName,
  onboardingInputClassName,
  onboardingReadableTextFaintClassName,
  onboardingReadableTextMutedClassName,
} from "./onboarding-form-primitives";
import {
  OnboardingLinkActionButton,
  OnboardingStepHeader,
  onboardingBodyTextShadowStyle,
  onboardingFooterClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
} from "./onboarding-step-chrome";

export interface PasswordSetupStepProps {
  /** When true this step can be skipped (cloud-provisioned break-glass). */
  optional?: boolean;
  /** Called after a successful setup submission — caller advances wizard. */
  onAdvance: () => void;
  /** Called when the user chooses to skip (only available when optional=true). */
  onSkip?: () => void;
  /** Injected for tests. */
  setupFn?: (params: {
    displayName: string;
    password: string;
  }) => Promise<AuthSetupResult>;
}

type SubmitState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "error"; message: string }
  | { phase: "success" };

export function PasswordSetupStep({
  optional = false,
  onAdvance,
  onSkip,
  setupFn,
}: PasswordSetupStepProps) {
  const displayNameId = useId().replace(/:/g, "");
  const passwordId = useId().replace(/:/g, "");
  const confirmId = useId().replace(/:/g, "");

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({
    phase: "idle",
  });

  const clearError = useCallback(() => {
    if (submitState.phase === "error") setSubmitState({ phase: "idle" });
  }, [submitState.phase]);

  const confirmMismatch =
    confirm.length > 0 && password !== confirm
      ? "Passwords do not match."
      : undefined;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (password !== confirm) {
        setSubmitState({ phase: "error", message: "Passwords do not match." });
        return;
      }
      setSubmitState({ phase: "submitting" });

      let result: AuthSetupResult;
      try {
        const fn = setupFn ?? authSetup;
        result = await fn({ displayName: displayName.trim(), password });
      } catch (err) {
        setSubmitState({
          phase: "error",
          message:
            err instanceof Error ? err.message : "Network error — try again.",
        });
        return;
      }

      if (!result.ok) {
        setSubmitState({ phase: "error", message: result.message });
        return;
      }

      setSubmitState({ phase: "success" });
      onAdvance();
    },
    [displayName, password, confirm, setupFn, onAdvance],
  );

  const isSubmitting = submitState.phase === "submitting";
  const canSubmit =
    displayName.trim().length > 0 &&
    password.length >= 12 &&
    password === confirm &&
    !isSubmitting;

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Password setup"
      className="flex w-full flex-col gap-6"
    >
      <OnboardingStepHeader
        eyebrow="Security"
        title="Set your login password"
        description={
          optional
            ? "Recommended. Without a fallback password, if Eliza Cloud is unreachable you will not be able to log in."
            : "Choose a strong password to protect access to this instance."
        }
      />

      {optional && (
        <div
          className={cn(
            "rounded-xl px-4 py-3",
            "border border-[rgba(240,185,11,0.28)] bg-[rgba(240,185,11,0.08)]",
          )}
        >
          <p
            className={cn(onboardingHelperTextClassName, "leading-relaxed")}
            style={onboardingBodyTextShadowStyle}
          >
            <span className={onboardingReadableTextMutedClassName}>
              This step is optional for cloud-provisioned containers.
            </span>{" "}
            <span className={onboardingReadableTextFaintClassName}>
              Eliza Cloud SSO is your primary login method. A fallback password
              lets you log in when the cloud is unavailable.
            </span>
          </p>
        </div>
      )}

      <div className={onboardingDetailStackClassName}>
        <OnboardingField
          controlId={displayNameId}
          label="Display name"
          description="Shown in the sessions list. Use a name you recognise."
        >
          {({ describedBy, invalid }) => (
            <input
              id={displayNameId}
              type="text"
              autoComplete="name"
              spellCheck={false}
              placeholder="e.g. Admin"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                clearError();
              }}
              disabled={isSubmitting}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              className={cn(
                onboardingInputClassName,
                invalid &&
                  "border-[var(--danger)] focus-visible:border-[var(--danger)]",
              )}
            />
          )}
        </OnboardingField>

        <OnboardingField
          controlId={passwordId}
          label="Password"
          description="Minimum 12 characters."
        >
          {({ describedBy, invalid }) => (
            <input
              id={passwordId}
              type="password"
              autoComplete="new-password"
              placeholder="At least 12 characters"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clearError();
              }}
              disabled={isSubmitting}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              className={cn(
                onboardingInputClassName,
                invalid &&
                  "border-[var(--danger)] focus-visible:border-[var(--danger)]",
              )}
            />
          )}
        </OnboardingField>

        <OnboardingField
          controlId={confirmId}
          label="Confirm password"
          message={confirmMismatch}
          messageTone={confirmMismatch ? "danger" : "default"}
        >
          {({ describedBy, invalid }) => (
            <input
              id={confirmId}
              type="password"
              autoComplete="new-password"
              placeholder="Repeat your password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                clearError();
              }}
              disabled={isSubmitting}
              aria-invalid={invalid || Boolean(confirmMismatch)}
              aria-describedby={describedBy}
              className={cn(
                onboardingInputClassName,
                (invalid || confirmMismatch) &&
                  "border-[var(--danger)] focus-visible:border-[var(--danger)]",
              )}
            />
          )}
        </OnboardingField>
      </div>

      {submitState.phase === "error" && (
        <OnboardingStatusBanner tone="error">
          {submitState.message}
        </OnboardingStatusBanner>
      )}

      <div
        className={cn(
          onboardingFooterClass,
          optional ? "justify-between" : "justify-end",
        )}
      >
        {optional && onSkip && (
          <OnboardingLinkActionButton
            type="button"
            onClick={onSkip}
            disabled={isSubmitting}
          >
            Skip for now
          </OnboardingLinkActionButton>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className={onboardingPrimaryActionClass}
          style={onboardingPrimaryActionTextShadowStyle}
        >
          {isSubmitting ? "Saving…" : "Set password"}
        </button>
      </div>
    </form>
  );
}
