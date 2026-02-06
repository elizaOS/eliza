"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import {
  usePrivy,
  useLoginWithEmail,
  useLoginWithOAuth,
} from "@privy-io/react-auth";
import { useRouter, useSearchParams } from "next/navigation";
import { BrandButton, BrandCard, CornerBrackets } from "@/components/brand";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, Wallet, Github, Chrome, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import LandingHeader from "@/components/layout/landing-header";

// Discord SVG Icon Component
const DiscordIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

function LoginPageContent() {
  const { ready, authenticated, login, user } = usePrivy();
  const { sendCode, loginWithCode, state: emailState } = useLoginWithEmail();
  const { initOAuth } = useLoginWithOAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [loadingButton, setLoadingButton] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isProcessingOAuth, setIsProcessingOAuth] = useState(() => {
    // Initialize OAuth processing state on client-side only to prevent SSR hydration mismatch
    if (typeof window === "undefined") return false;
    const urlParams = new URLSearchParams(window.location.search);
    const hasOAuthParams =
      urlParams.has("privy_oauth_code") ||
      urlParams.has("privy_oauth_state") ||
      urlParams.has("code") ||
      urlParams.has("state");
    const sessionFlag = sessionStorage.getItem("oauth_login_pending");
    return hasOAuthParams || sessionFlag === "true";
  });

  // Check if this is a signup intent (from "Get Started" button)
  const isSignupIntent = searchParams.get("intent") === "signup";

  // Guard against multiple simultaneous login() calls (critical for macOS/Brave)
  const loginInProgressRef = useRef(false);
  const lastLoginAttemptRef = useRef<number>(0);

  // Redirect after authentication - respects returnTo parameter
  useEffect(() => {
    if (ready && authenticated) {
      // Clear OAuth session flag and guards
      sessionStorage.removeItem("oauth_login_pending");
      loginInProgressRef.current = false;
      // Use setTimeout to avoid synchronous setState in effect
      setTimeout(() => {
        setLoadingButton(null);
        setIsProcessingOAuth(false);
        // Show syncing state before redirect
        setIsSyncing(true);
      }, 0);

      // Get the return URL from search params, default to dashboard
      const returnTo = searchParams.get("returnTo");
      // Validate returnTo is a relative path (security: prevent open redirects)
      const isValidReturnTo =
        returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//");
      const redirectUrl = isValidReturnTo ? returnTo : "/dashboard";

      // Small delay to ensure the sync message is visible
      // Use router.replace to avoid polluting browser history with /login
      const timer = setTimeout(() => {
        router.replace(redirectUrl);
      }, 100);

      return () => clearTimeout(timer);
    } else if (ready && !authenticated) {
      // If we're ready but not authenticated, ensure guard is cleared
      // (handles case where user closes modal without connecting)
      if (loginInProgressRef.current && !loadingButton) {
        loginInProgressRef.current = false;
      }
      // If OAuth processing timed out (ready but not authenticated after callback)
      // clear the flag after a small delay to allow Privy to finish
      if (isProcessingOAuth) {
        const timeout = setTimeout(() => {
          setIsProcessingOAuth(false);
          sessionStorage.removeItem("oauth_login_pending");
        }, 3000); // Give Privy 3 seconds to complete auth
        return () => clearTimeout(timeout);
      }
    }
  }, [
    ready,
    authenticated,
    router,
    loadingButton,
    user,
    isProcessingOAuth,
    searchParams,
  ]);

  // Monitor email state to show code input
  useEffect(() => {
    if (emailState.status === "awaiting-code-input") {
      // Use setTimeout to avoid synchronous setState in effect
      setTimeout(() => {
        setShowCodeInput(true);
      }, 0);
    }
  }, [emailState.status]);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !email.includes("@")) {
      toast.error("Please enter a valid email address");
      return;
    }

    setLoadingButton("email");
    await sendCode({ email });
    toast.success("Verification code sent to your email");
    setShowCodeInput(true);
    setLoadingButton(null);
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!code || code.length !== 6) {
      toast.error("Please enter a valid 6-digit code");
      return;
    }

    setLoadingButton("verify");
    await loginWithCode({ code });
    toast.success("Email verified! Setting up your account...");
    // Privy will auto-redirect to dashboard via our useEffect
    setLoadingButton(null);
  };

  const handleOAuthLogin = async (
    provider: "google" | "discord" | "github",
  ) => {
    setLoadingButton(provider);
    // Set session flag to detect OAuth callback when returning
    sessionStorage.setItem("oauth_login_pending", "true");
    toast.loading(`Redirecting to ${provider}...`);
    await initOAuth({ provider });
    // This will redirect to OAuth provider
  };

  const handleWalletConnect = async () => {
    // Guard: Prevent multiple simultaneous login attempts (macOS/Brave issue)
    if (loginInProgressRef.current) {
      return;
    }

    // Debounce: Prevent rapid successive calls (500ms cooldown)
    const now = Date.now();
    if (now - lastLoginAttemptRef.current < 500) {
      return;
    }

    // Guard: Don't open login if already authenticated
    if (authenticated) {
      return;
    }

    // Set guards
    loginInProgressRef.current = true;
    lastLoginAttemptRef.current = now;
    setLoadingButton("wallet");

    // Use login() instead of connectWallet() for authentication
    // This opens the Privy modal (non-blocking, returns immediately)
    // Authentication state changes are handled via the authenticated state in useEffect
    login();

    // Reset the guard after a short delay to allow modal to open
    // If authentication succeeds, the useEffect will handle redirect
    // If user closes modal, this timeout resets the guard for retry
    setTimeout(() => {
      // Only reset if still in progress (not authenticated yet)
      if (loginInProgressRef.current) {
        loginInProgressRef.current = false;
        setLoadingButton(null);
      }
    }, 2000); // 2 second timeout
  };

  const handleBackToEmail = () => {
    setShowCodeInput(false);
    setCode("");
  };

  // Show loading state while checking authentication or processing OAuth callback
  if (!ready || isProcessingOAuth) {
    return (
      <div className="relative flex min-h-screen w-full flex-col overflow-hidden">
        {/* Header */}
        <LandingHeader />

        {/* Fullscreen background video */}
        <video
          src="/videos/Hero Cloud_x3 Slower_1_Scale 5.mp4"
          autoPlay
          loop
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
          style={{
            filter: "brightness(0.4) blur(2px)",
          }}
        />

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-black/60 via-black/40 to-black/60" />

        <div className="relative z-10 flex flex-1 items-center justify-center p-4">
          <BrandCard className="w-full max-w-md backdrop-blur-sm bg-black/60">
            <CornerBrackets size="md" className="opacity-50" />
            <div className="relative z-10 flex flex-col items-center gap-6 py-8">
              <div className="relative">
                <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
                <div className="absolute inset-0 h-12 w-12 animate-pulse rounded-full bg-[#FF5800]/20 blur-xl" />
              </div>
              <div className="space-y-2 text-center">
                <h3 className="text-lg font-semibold text-white">
                  {isProcessingOAuth ? "Completing sign in..." : "Loading..."}
                </h3>
                <p className="text-sm text-white/60">
                  {isProcessingOAuth
                    ? "Processing your authentication"
                    : "Initializing..."}
                </p>
              </div>
              <div className="flex gap-1">
                <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.3s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.15s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800]" />
              </div>
            </div>
          </BrandCard>
        </div>
      </div>
    );
  }

  // Don't render login page if already authenticated (redirecting)
  if (authenticated || isSyncing) {
    return (
      <div className="relative flex min-h-screen w-full flex-col overflow-hidden">
        {/* Header */}
        <LandingHeader />

        {/* Fullscreen background video */}
        <video
          src="/videos/Hero Cloud_x3 Slower_1_Scale 5.mp4"
          autoPlay
          loop
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
          style={{
            filter: "brightness(0.4) blur(2px)",
          }}
        />

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-black/60 via-black/40 to-black/60" />

        <div className="relative z-10 flex flex-1 items-center justify-center p-4">
          <BrandCard className="w-full max-w-md backdrop-blur-sm bg-black/60">
            <CornerBrackets size="md" className="opacity-50" />
            <div className="relative z-10 flex flex-col items-center gap-6 py-8">
              <div className="relative">
                <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
                <div className="absolute inset-0 h-12 w-12 animate-pulse rounded-full bg-[#FF5800]/20 blur-xl" />
              </div>
              <div className="space-y-2 text-center">
                <h3 className="text-lg font-semibold text-white">
                  Signing you in
                </h3>
                <p className="text-sm text-white/60">
                  Taking you to your dashboard...
                </p>
              </div>
              <div className="flex gap-1">
                <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.3s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.15s]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800]" />
              </div>
            </div>
          </BrandCard>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden">
      {/* Header */}
      <LandingHeader />

      {/* Fullscreen background video */}
      <video
        src="/videos/Hero Cloud_x3 Slower_1_Scale 5.mp4"
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        style={{
          filter: "brightness(0.4) blur(2px)",
        }}
      />

      {/* Gradient overlay for better text readability */}
      <div className="absolute inset-0 bg-gradient-to-br from-black/60 via-black/40 to-black/60" />

      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <BrandCard className="w-full max-w-md backdrop-blur-sm bg-black/60">
          <CornerBrackets size="md" className="opacity-50" />

          <div className="relative z-10 space-y-6">
            {/* Header */}
            <div className="space-y-3 text-center pb-2">
              <h1 className="text-3xl font-bold tracking-tight text-white">
                {isSignupIntent ? "Sign Up" : "Welcome back"}
              </h1>
              <p className="text-base text-white/60">
                {isSignupIntent
                  ? "Create your elizaOS account"
                  : "Sign in to your elizaOS account"}
              </p>
            </div>
            {/* Email/Code Login Section */}
            {!showCodeInput ? (
              // Email Input
              <form onSubmit={handleSendCode} className="space-y-4">
                <div className="space-y-2">
                  <label
                    htmlFor="email"
                    className="text-xs font-medium text-white/70 uppercase tracking-wide"
                  >
                    Email Address
                  </label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loadingButton !== null}
                    className="h-11 rounded-none border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800]"
                    autoFocus
                  />
                </div>
                <BrandButton
                  type="submit"
                  disabled={loadingButton !== null || !email}
                  variant="primary"
                  className="w-full h-11"
                >
                  {loadingButton === "email" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending code...
                    </>
                  ) : (
                    <>
                      <Mail className="mr-2 h-4 w-4" />
                      Continue with Email
                    </>
                  )}
                </BrandButton>
              </form>
            ) : (
              // Code Input
              <form onSubmit={handleVerifyCode} className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="code"
                      className="text-xs font-medium text-white/70 uppercase tracking-wide"
                    >
                      Verification Code
                    </label>
                    <BrandButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleBackToEmail}
                      className="h-auto p-0"
                    >
                      <ArrowLeft className="mr-1 h-3 w-3" />
                      Change email
                    </BrandButton>
                  </div>
                  <Input
                    id="code"
                    type="text"
                    placeholder="000000"
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    disabled={loadingButton !== null}
                    className="h-11 rounded-none border-white/10 bg-black/40 text-white placeholder:text-white/40 focus:ring-1 focus:ring-[#FF5800] focus:border-[#FF5800] text-center text-lg tracking-widest"
                    maxLength={6}
                    autoFocus
                  />
                  <p className="text-xs text-white/50 text-center">
                    Enter the 6-digit code sent to{" "}
                    <span className="font-medium text-white/70">{email}</span>
                  </p>
                </div>
                <BrandButton
                  type="submit"
                  disabled={loadingButton !== null || code.length !== 6}
                  variant="primary"
                  className="w-full h-11"
                >
                  {loadingButton === "verify" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    "Verify & Sign In"
                  )}
                </BrandButton>
                <BrandButton
                  type="button"
                  variant="outline"
                  onClick={handleSendCode}
                  disabled={loadingButton !== null}
                  className="w-full"
                >
                  {loadingButton === "email" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    "Resend Code"
                  )}
                </BrandButton>
              </form>
            )}

            {/* Only show other login options on the initial screen */}
            {!showCodeInput && (
              <>
                {/* Divider */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-white/10" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-black/60 px-2 text-white/50">
                      Or continue with
                    </span>
                  </div>
                </div>

                {/* OAuth Buttons */}
                <div className="grid gap-3">
                  <BrandButton
                    variant="outline"
                    onClick={() => handleOAuthLogin("google")}
                    disabled={loadingButton !== null}
                    className="w-full h-11"
                  >
                    {loadingButton === "google" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Chrome className="mr-2 h-4 w-4" />
                    )}
                    Google
                  </BrandButton>

                  <BrandButton
                    variant="outline"
                    onClick={() => handleOAuthLogin("discord")}
                    disabled={loadingButton !== null}
                    className="w-full h-11"
                  >
                    {loadingButton === "discord" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <DiscordIcon className="mr-2 h-4 w-4" />
                    )}
                    Discord
                  </BrandButton>

                  <BrandButton
                    variant="outline"
                    onClick={() => handleOAuthLogin("github")}
                    disabled={loadingButton !== null}
                    className="w-full h-11"
                  >
                    {loadingButton === "github" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Github className="mr-2 h-4 w-4" />
                    )}
                    GitHub
                  </BrandButton>
                </div>

                {/* Divider */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-white/10" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-black/60 px-2 text-white/50">
                      Or use wallet
                    </span>
                  </div>
                </div>

                {/* Wallet Connect */}
                <BrandButton
                  variant="outline"
                  onClick={handleWalletConnect}
                  disabled={loadingButton !== null}
                  className="w-full h-11 border-[#FF5800]/30 hover:border-[#FF5800]"
                >
                  {loadingButton === "wallet" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Wallet className="mr-2 h-4 w-4" />
                  )}
                  Connect Wallet
                </BrandButton>
              </>
            )}

            {/* Footer */}
            <p className="text-center text-xs text-white/50 pt-2 border-t border-white/10">
              By signing in, you agree to our{" "}
              <a
                href="/terms-of-service"
                className="underline underline-offset-4 hover:text-[#FF5800] transition-colors"
              >
                Terms of Service
              </a>{" "}
              and{" "}
              <a
                href="/privacy-policy"
                className="underline underline-offset-4 hover:text-[#FF5800] transition-colors"
              >
                Privacy Policy
              </a>
            </p>
          </div>
        </BrandCard>
      </div>
    </div>
  );
}

// Loading fallback component - matches the styled loading state
function LoginPageFallback() {
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-black">
      {/* Fullscreen background video */}
      <video
        src="/videos/Hero Cloud_x3 Slower_1_Scale 5.mp4"
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
        style={{
          filter: "brightness(0.4) blur(2px)",
        }}
      />

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-br from-black/60 via-black/40 to-black/60" />

      <div className="relative z-10 flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-md rounded-lg border border-white/10 backdrop-blur-sm bg-black/60 p-8">
          <div className="flex flex-col items-center gap-6 py-8">
            <div className="relative">
              <Loader2 className="h-12 w-12 animate-spin text-[#FF5800]" />
              <div className="absolute inset-0 h-12 w-12 animate-pulse rounded-full bg-[#FF5800]/20 blur-xl" />
            </div>
            <div className="space-y-2 text-center">
              <h3 className="text-lg font-semibold text-white">Loading...</h3>
              <p className="text-sm text-white/60">Initializing...</p>
            </div>
            <div className="flex gap-1">
              <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.3s]" />
              <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800] [animation-delay:-0.15s]" />
              <div className="h-2 w-2 animate-bounce rounded-full bg-[#FF5800]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Login page component with authentication options.
 * Supports email verification, OAuth (Google, Discord, GitHub), and wallet connection.
 * Wrapped in Suspense for client-side navigation.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginPageFallback />}>
      <LoginPageContent />
    </Suspense>
  );
}
