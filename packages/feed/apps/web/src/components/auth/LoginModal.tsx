"use client";

import { logger } from "@feed/shared";
import { useCallback, useEffect, useState } from "react";
import { useStewardAuthContext } from "@/components/providers/StewardAuthProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";

/**
 * Steward-backed login modal.
 *
 * Supports:
 * - Email magic link (no password)
 * - Passkey (WebAuthn)
 * - OAuth: Google, Discord, Twitter/X
 * - Farcaster SIWF
 */

type Step = "idle" | "email-sent" | "loading" | "error";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
}

function getStewardApiUrl(): string {
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_STEWARD_API_URL ?? "http://localhost:3200";
  }
  return process.env.NEXT_PUBLIC_STEWARD_API_URL ?? "http://localhost:3200";
}

const STEWARD_TENANT_ID = process.env.NEXT_PUBLIC_STEWARD_TENANT_ID ?? "feed";

/** Build the Steward OAuth authorize URL. Callback lands on our /auth/callback/[provider] page. */
function oauthUrl(provider: string): string {
  const stewardBase = getStewardApiUrl();
  const callbackBase =
    typeof window !== "undefined" ? window.location.origin : "";
  const redirectUri = `${callbackBase}/auth/callback/${provider}`;
  return (
    `${stewardBase}/auth/oauth/${provider}/authorize` +
    `?redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&tenant_id=${encodeURIComponent(STEWARD_TENANT_ID)}`
  );
}

export function LoginModal({
  isOpen,
  onClose,
  title,
  message,
}: LoginModalProps) {
  const { stewardAuth, onLoginSuccess } = useStewardAuthContext();
  const { authenticated } = useAuth();
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (authenticated && isOpen) onClose();
  }, [authenticated, isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) {
      setStep("idle");
      setEmail("");
      setErrorMsg("");
    }
  }, [isOpen]);

  const handleEmailLogin = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed?.includes("@")) {
      setErrorMsg("Please enter a valid email address.");
      return;
    }
    setStep("loading");
    setErrorMsg("");
    try {
      const result = await stewardAuth.signInWithEmail(trimmed);
      if (result.ok) {
        setStep("email-sent");
        logger.info("Magic link sent", { email: trimmed }, "LoginModal");
      } else {
        setErrorMsg("Failed to send magic link. Please try again.");
        setStep("error");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.warn("Email login failed", { error: msg }, "LoginModal");
      setErrorMsg(msg);
      setStep("error");
    }
  }, [email, stewardAuth]);

  const handlePasskeyLogin = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed?.includes("@")) {
      setErrorMsg("Please enter your email address to use a passkey.");
      return;
    }
    setStep("loading");
    setErrorMsg("");
    try {
      const result = await stewardAuth.signInWithPasskey(trimmed);
      await onLoginSuccess(result.token);
      logger.info("Passkey login successful", { email: trimmed }, "LoginModal");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Passkey login failed";
      logger.warn("Passkey login failed", { error: msg }, "LoginModal");
      setErrorMsg(msg);
      setStep("error");
    }
  }, [email, stewardAuth, onLoginSuccess]);

  const handleOAuth = useCallback(
    (provider: "google" | "discord" | "twitter") => {
      window.location.href = oauthUrl(provider);
    },
    [],
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="p-8 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-center text-xl">
            {title ?? "Sign in to Feed"}
          </DialogTitle>
          {message && (
            <DialogDescription className="text-center">
              {message}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-1">
          {step === "email-sent" ? (
            <div className="rounded-xl border bg-muted/50 p-5 text-center">
              <div className="mb-2 text-2xl">📬</div>
              <p className="font-semibold">Check your inbox</p>
              <p className="mt-1 text-muted-foreground text-sm">
                We sent a magic link to <strong>{email}</strong>.
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                No email? Check spam or{" "}
                <button
                  className="text-primary underline-offset-4 hover:underline"
                  onClick={() => setStep("idle")}
                  type="button"
                >
                  try again
                </button>
                .
              </p>
            </div>
          ) : (
            <>
              {/* OAuth buttons — always enabled */}
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleOAuth("google")}
                  disabled={step === "loading"}
                  className="w-full gap-2"
                >
                  <GoogleIcon />
                  Continue with Google
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleOAuth("discord")}
                  disabled={step === "loading"}
                  className="w-full gap-2"
                >
                  <DiscordIcon />
                  Continue with Discord
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleOAuth("twitter")}
                  disabled={step === "loading"}
                  className="w-full gap-2"
                >
                  <XIcon />
                  Continue with X
                </Button>
              </div>

              {/* Farcaster */}
              <FarcasterSignInSection
                onLoginSuccess={onLoginSuccess}
                onClose={onClose}
                loading={step === "loading"}
              />

              <div className="relative flex items-center gap-3">
                <div className="flex-1 border-t" />
                <span className="text-muted-foreground text-xs">
                  or use email
                </span>
                <div className="flex-1 border-t" />
              </div>

              {/* Email + Passkey */}
              <div className="flex flex-col gap-2">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleEmailLogin();
                  }}
                  disabled={step === "loading"}
                  autoComplete="email"
                  className="h-10"
                />
                <div className="flex gap-2">
                  <Button
                    onClick={() => void handleEmailLogin()}
                    disabled={step === "loading" || !email.trim()}
                    className="flex-1"
                    size="sm"
                  >
                    {step === "loading" ? (
                      <span className="flex items-center gap-2">
                        <LoadingSpinner />
                        Sending…
                      </span>
                    ) : (
                      "Send link"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void handlePasskeyLogin()}
                    disabled={step === "loading" || !email.trim()}
                    className="flex-1"
                    size="sm"
                    title="Sign in with a passkey (biometric / hardware key)"
                  >
                    🔑 Passkey
                  </Button>
                </div>
              </div>

              {errorMsg && (
                <p className="text-center text-destructive text-xs">
                  {errorMsg}
                </p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Farcaster section ─────────────────────────────────────────────────────────

function FarcasterSignInSection({
  onLoginSuccess,
  onClose,
  loading,
}: {
  onLoginSuccess: (token: string) => Promise<void>;
  onClose: () => void;
  loading: boolean;
}) {
  const [error, setError] = useState("");
  const [SignInButton, setSignInButton] = useState<React.ComponentType<{
    onSuccess?: (res: unknown) => void;
    onError?: (err: unknown) => void;
  }> | null>(null);

  useEffect(() => {
    import("@farcaster/auth-kit")
      .then((mod) => setSignInButton(() => mod.SignInButton))
      .catch(() => {
        // auth-kit unavailable — omit the button silently
      });
  }, []);

  const handleSuccess = useCallback(
    async (res: { message?: string; signature?: string; nonce?: string }) => {
      setError("");
      try {
        const r = await fetch("/api/auth/farcaster", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            message: res.message,
            signature: res.signature,
            nonce: res.nonce,
          }),
        });
        const data = (await r.json()) as {
          ok: boolean;
          token?: string;
          error?: string;
        };
        if (!data.ok || !data.token)
          throw new Error(data.error ?? "Farcaster auth failed");
        await onLoginSuccess(data.token);
        onClose();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Farcaster sign-in failed";
        logger.warn("Farcaster SIWF failed", { error: msg }, "LoginModal");
        setError(msg);
      }
    },
    [onLoginSuccess, onClose],
  );

  if (!SignInButton) return null;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className={loading ? "pointer-events-none opacity-50" : ""}>
        <SignInButton
          onSuccess={(res) =>
            void handleSuccess(res as Parameters<typeof handleSuccess>[0])
          }
          onError={(err) => {
            const msg =
              err instanceof Error ? err.message : "Farcaster sign-in error";
            setError(msg);
          }}
        />
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

// ── Icon SVGs ─────────────────────────────────────────────────────────────────

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg className="size-4 fill-[#5865F2]" viewBox="0 0 24 24" aria-hidden>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="size-4 fill-current" viewBox="0 0 24 24" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function LoadingSpinner() {
  return (
    <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
  );
}
