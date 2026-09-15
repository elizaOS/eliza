/** Offers passkey enrollment after another login method establishes the account session. */
import { useContext, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { PasskeyIcon } from "../icons/index.js";
import { LoginAuthContext } from "../provider.js";
import { PASSKEY_ENROLL_PROMPT_KEY } from "./LoginForm.js";

interface PasskeyEnrollmentPromptProps {
  /**
   * Visual style:
   *   - `banner` (default): full-width strip mounted at the top of a layout.
   *   - `inline`: card-like surface for placement inside a settings page.
   *   - `toast`: corner-anchored, smaller footprint.
   */
  variant?: "banner" | "inline" | "toast";
  /** Custom heading. Defaults to "Sign in faster next time". */
  title?: string;
  /** Custom body copy. Defaults to a context-aware explanation. */
  description?: string;
  /** Callback after successful enrollment. */
  onEnrolled?: () => void;
  /** Callback when the user dismisses without enrolling. */
  onDismissed?: () => void;
  /**
   * If true, render even when the sessionStorage flag is not set. Use this
   * when the consumer surfaces the prompt from settings rather than relying
   * on the post-magic-link auto-trigger.
   */
  alwaysShow?: boolean;
  className?: string;
}

/**
 * Surfaces a "register a passkey on this device" prompt after a user signs
 * in with a fallback method (typically email magic link) on a relying party
 * where they don't yet have a passkey registered.
 *
 * The component listens for the `PASSKEY_ENROLL_PROMPT_KEY` flag that
 * `<LoginForm>` writes to sessionStorage whenever it transparently falls
 * back from passkey → email. Mount this once at the top of an authenticated
 * shell (e.g. dashboard layout) and it will only render when:
 *
 *   1. There is an authenticated session, AND
 *   2. The fallback flag is present and matches the current user's email
 *      (or `alwaysShow` is set)
 *
 * Dismissing (✕) or enrolling clears the flag so the prompt won't reappear
 * until the next cross-RP fallback.
 */
export function PasskeyEnrollmentPrompt({
  variant = "banner",
  title = "Sign in faster next time",
  description,
  onEnrolled,
  onDismissed,
  alwaysShow = false,
  className,
}: PasskeyEnrollmentPromptProps) {
  const ctx = useContext(LoginAuthContext);
  const [visible, setVisible] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Read the fallback flag once on mount. We deliberately don't poll — the
  // prompt is meant to appear in response to a recent login event, so the
  // sessionStorage value should already be present when this component
  // first renders inside the authenticated shell.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!ctx?.isAuthenticated || !ctx.user?.email) return;
    try {
      const flag = window.sessionStorage.getItem(PASSKEY_ENROLL_PROMPT_KEY);
      const userEmail = ctx.user.email.toLowerCase();
      if (alwaysShow || (flag && flag.toLowerCase() === userEmail)) {
        setPendingEmail(ctx.user.email);
        setVisible(true);
      }
    } catch {
      // sessionStorage blocked (private browsing, sandboxed) — silently skip.
    }
  }, [ctx?.isAuthenticated, ctx?.user?.email, alwaysShow]);

  const clearFlag = () => {
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(PASSKEY_ENROLL_PROMPT_KEY);
      }
    } catch {
      // ignored
    }
  };

  const handleEnroll = async () => {
    if (!ctx || !pendingEmail || !ctx.addPasskey) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await ctx.addPasskey(pendingEmail);
      clearFlag();
      setVisible(false);
      onEnrolled?.();
    } catch (err) {
      // Common reason: user cancelled the system passkey prompt. Keep the
      // banner mounted so they can try again, but surface the failure.
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    clearFlag();
    setVisible(false);
    onDismissed?.();
  };

  if (!visible || !ctx?.isAuthenticated) return null;

  const variantClass =
    variant === "inline"
      ? "stwd-passkey-enroll--inline"
      : variant === "toast"
        ? "stwd-passkey-enroll--toast"
        : "stwd-passkey-enroll--banner";

  return (
    <section
      className={`stwd-passkey-enroll ${variantClass} ${className ?? ""}`}
      aria-label="Add a passkey"
    >
      <div className="stwd-passkey-enroll__icon" aria-hidden="true">
        <PasskeyIcon size={20} />
      </div>
      <div className="stwd-passkey-enroll__body">
        <p className="stwd-passkey-enroll__title">{title}</p>
        <p className="stwd-passkey-enroll__description">
          {description ??
            "Save a passkey on this device so you can sign in with a single tap. Works alongside any passkeys you already have on other apps."}
        </p>
        {errorMsg && (
          <p className="stwd-passkey-enroll__error" role="alert">
            {errorMsg}
          </p>
        )}
      </div>
      <div className="stwd-passkey-enroll__actions">
        <Button
          type="button"
          className="stwd-passkey-enroll__btn stwd-passkey-enroll__btn--primary"
          onClick={() => void handleEnroll()}
          disabled={busy || !ctx.addPasskey}
        >
          {busy ? "Adding…" : "Add passkey"}
        </Button>
        <Button
          type="button"
          className="stwd-passkey-enroll__btn stwd-passkey-enroll__btn--dismiss"
          onClick={handleDismiss}
          disabled={busy}
          aria-label="Dismiss"
        >
          Not now
        </Button>
      </div>
    </section>
  );
}
