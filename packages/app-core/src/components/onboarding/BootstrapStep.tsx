/**
 * BootstrapStep — cloud-provisioned containers only.
 *
 * Prompts the user to paste their bootstrap token (copied from the Eliza Cloud
 * dashboard). On success the returned session id is written to
 * sessionStorage["milady_session"] and the `onAdvance` callback fires.
 *
 * P1 will migrate the session to an HttpOnly cookie and retire sessionStorage.
 * The key name is kept in sync with the cookie name planned for P1
 * (milady_session) so the P1 migration is a straightforward swap.
 *
 * Error contract (fail closed):
 *   401 → token invalid / expired / already used, single-use, must rotate.
 *   429 → rate limited.
 *   5xx → server not ready.
 *   network → surfaces to user; never treated as success.
 */

import { cn } from "@elizaos/ui";
import { useCallback, useId, useRef, useState } from "react";
import type { BootstrapExchangeResult } from "../../api/client-agent";
import {
  onboardingDetailStackClassName,
  onboardingHelperTextClassName,
  onboardingInputClassName,
  onboardingReadableTextFaintClassName,
  onboardingReadableTextMutedClassName,
  OnboardingStatusBanner,
  OnboardingField,
} from "./onboarding-form-primitives";
import {
  onboardingBodyTextShadowStyle,
  onboardingDescriptionClass,
  onboardingEyebrowClass,
  onboardingFooterClass,
  onboardingHeaderBlockClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
  OnboardingStepDivider,
  onboardingTextShadowStyle,
  onboardingTitleClass,
} from "./onboarding-step-chrome";

const SESSION_STORAGE_KEY = "milady_session";
const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

export interface BootstrapStepProps {
  /**
   * Called after a successful exchange. The caller is responsible for
   * advancing the wizard.
   */
  onAdvance: () => void;
  /**
   * Injected exchange function — defaults to the real API client call but
   * can be swapped in tests.
   */
  exchangeFn?: (token: string) => Promise<BootstrapExchangeResult>;
}

type SubmitState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "error"; message: string; tone: "danger" }
  | { phase: "success" };

function describeError(result: BootstrapExchangeResult & { ok: false }): string {
  if (result.status === 429) {
    return "Too many attempts — wait a minute and try again.";
  }
  if (result.status === 503) {
    return "The server is not ready. Reload the page and try again.";
  }
  if (result.status === 400) {
    return "No token provided. Paste the token from your Eliza Cloud dashboard.";
  }
  // 401 — invalid / expired / already used
  return "Token invalid, expired, or already used. Bootstrap tokens are single-use — rotate from your Eliza Cloud dashboard to get a new one.";
}

export function BootstrapStep({ onAdvance, exchangeFn }: BootstrapStepProps) {
  const fieldId = useId().replace(/:/g, "");
  const [token, setToken] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({
    phase: "idle",
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const doExchange = useCallback(
    async (rawToken: string): Promise<void> => {
      setSubmitState({ phase: "submitting" });

      let result: BootstrapExchangeResult;
      try {
        if (exchangeFn) {
          result = await exchangeFn(rawToken);
        } else {
          // Lazy-import the real client to avoid a hard dependency in tests.
          const { client } = await import("../../api");
          result = await client.postBootstrapExchange(rawToken);
        }
      } catch (err) {
        // Network down or unexpected throw — surface to user, do not proceed.
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Network error — check your connection and try again.";
        setSubmitState({ phase: "error", message, tone: "danger" });
        return;
      }

      if (!result.ok) {
        setSubmitState({
          phase: "error",
          message: describeError(result),
          tone: "danger",
        });
        return;
      }

      // P0 bridge: write session id to sessionStorage. P1 replaces this with
      // an HttpOnly cookie set by the server on the exchange response.
      try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, result.sessionId);
      } catch {
        // sessionStorage unavailable (e.g. private browsing on some browsers).
        // Session is still in memory for this page load; the wizard can advance.
      }

      setSubmitState({ phase: "success" });
      onAdvance();
    },
    [exchangeFn, onAdvance],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = token.trim();
      if (!trimmed) return;
      void doExchange(trimmed);
    },
    [token, doExchange],
  );

  const isSubmitting = submitState.phase === "submitting";

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Bootstrap token entry"
      className="flex w-full flex-col gap-6"
    >
      {/* Header */}
      <div className={onboardingHeaderBlockClass}>
        <p
          className={onboardingEyebrowClass}
          style={onboardingBodyTextShadowStyle}
        >
          Eliza Cloud
        </p>
        <OnboardingStepDivider />
        <h1
          className={onboardingTitleClass}
          style={onboardingTextShadowStyle}
        >
          Finish setting up your container
        </h1>
        <p
          className={onboardingDescriptionClass}
          style={onboardingBodyTextShadowStyle}
        >
          Paste the bootstrap token from your Eliza Cloud dashboard to activate
          this container.
        </p>
      </div>

      {/* Field */}
      <div className={onboardingDetailStackClassName}>
        <OnboardingField
          controlId={fieldId}
          label="Bootstrap token"
          message={
            submitState.phase === "error" ? submitState.message : undefined
          }
          messageTone={
            submitState.phase === "error" ? submitState.tone : undefined
          }
        >
          {({ describedBy, invalid }) => (
            <input
              ref={inputRef}
              id={fieldId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your bootstrap token here"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                if (submitState.phase === "error") {
                  setSubmitState({ phase: "idle" });
                }
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
      </div>

      {/* Where to get the token */}
      <div
        className={cn(
          "rounded-xl px-4 py-3",
          "border border-[rgba(240,185,11,0.18)] bg-[rgba(240,185,11,0.07)]",
        )}
      >
        <p
          className={cn(onboardingHelperTextClassName, "leading-relaxed")}
          style={onboardingBodyTextShadowStyle}
        >
          <span
            className={onboardingReadableTextMutedClassName}
            style={{ fontFamily: MONO_FONT }}
          >
            Where do I get this?
          </span>{" "}
          <span className={onboardingReadableTextFaintClassName}>
            Open your Eliza Cloud dashboard, select this container, and copy
            the token shown under &ldquo;Bootstrap token&rdquo;. It is valid
            for 24 hours and can only be used once.{" "}
            <a
              href="/docs/security/bootstrap-token"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-[var(--onboarding-text-muted)] transition-colors"
            >
              Learn more
            </a>
          </span>
        </p>
      </div>

      {/* Footer */}
      <div className={cn(onboardingFooterClass, "justify-end")}>
        <button
          type="submit"
          disabled={isSubmitting || !token.trim()}
          className={onboardingPrimaryActionClass}
          style={onboardingPrimaryActionTextShadowStyle}
        >
          {isSubmitting ? "Verifying…" : "Activate"}
        </button>
      </div>
    </form>
  );
}
