"use client";

import { cn } from "@polyagent/shared";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useAuth } from "@/hooks/useAuth";

/**
 * Feed authentication banner content component.
 *
 * Displays a fixed bottom banner prompting unauthenticated users to log in.
 * Automatically hides when WAITLIST_MODE is enabled on home page unless
 * dev mode is enabled via URL parameter (?dev=true). Only shows when auth
 * state is ready and user is not authenticated.
 *
 * @returns Feed auth banner element or null if hidden/not needed
 */
function FeedAuthBannerContent() {
  const { login, authenticated, ready } = useAuth();
  const searchParams = useSearchParams();

  // Check if dev mode is enabled via URL parameter (for staging testing)
  const isDevMode = searchParams.get("dev") === "true";

  // Hide when WAITLIST_MODE is enabled on home page (unless ?dev=true)
  const isWaitlistMode = process.env.NEXT_PUBLIC_WAITLIST_MODE === "true";
  const isHomePage =
    typeof window !== "undefined" && window.location.pathname === "/";
  const shouldHide = isWaitlistMode && isHomePage && !isDevMode;

  // If should be hidden, don't render anything
  if (shouldHide) {
    return null;
  }

  // Don't show until auth state is ready (prevents flash on load)
  if (!ready) {
    return null;
  }

  // Don't show if user is authenticated
  if (authenticated) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed right-0 bottom-0 left-0 z-50",
        "bg-background text-foreground",
        "border-border border-t-2",
      )}
    >
      <div className="mx-auto max-w-7xl px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <h3 className="mb-1 font-bold text-lg">Join the conversation.</h3>
            <p className="text-sm opacity-90">You&apos;re still early!</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={login}
              className={cn(
                "px-6 py-2 font-bold",
                "bg-background text-foreground",
                "hover:bg-background/90 hover:text-foreground",
                "transition-colors",
                "bg-primary text-primary-foreground",
              )}
            >
              Log in
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Feed authentication banner component wrapper with Suspense boundary.
 *
 * Wraps FeedAuthBannerContent in a Suspense boundary to handle async navigation
 * hooks gracefully. Provides authentication prompt banner for feed pages.
 *
 * @returns Feed auth banner element wrapped in Suspense
 */
export function FeedAuthBanner() {
  return (
    <Suspense fallback={null}>
      <FeedAuthBannerContent />
    </Suspense>
  );
}
