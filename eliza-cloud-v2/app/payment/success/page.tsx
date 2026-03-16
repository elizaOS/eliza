"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { Loader2, CheckCircle } from "lucide-react";
import { trackEvent } from "@/lib/analytics/posthog";

/**
 * Payment Success Callback Page
 *
 * This is a public page that handles redirects from external payment providers (OxaPay).
 * It checks authentication client-side and redirects to the appropriate destination.
 *
 * Flow:
 * 1. OxaPay redirects here after successful payment
 * 2. Page checks if user is authenticated via Privy (client-side)
 * 3. If authenticated, redirects to /dashboard/settings?tab=billing&payment=success
 * 4. If not authenticated, redirects to login with return URL
 */
function PaymentSuccessContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { ready, authenticated } = usePrivy();
  const hasTracked = useRef(false);

  // Extract trackId once to use as stable dependency
  const trackId = searchParams.get("trackId");

  // Track payment success viewed (only once per trackId)
  // Use trackId as dedup key - ensures one event per crypto payment
  // Wait for auth to be ready to ensure proper user attribution
  useEffect(() => {
    if (ready && authenticated && !hasTracked.current && trackId) {
      trackEvent("payment_success_viewed", {
        source: "crypto",
        track_id: trackId,
        // Include dedup_id for PostHog deduplication in case of page refresh
        dedup_id: `crypto_success_${trackId}`,
      });
      hasTracked.current = true;
    }
  }, [ready, authenticated, trackId]);

  useEffect(() => {
    if (!ready) return;

    const trackId = searchParams.get("trackId");
    const status = searchParams.get("status");

    const targetUrl = new URL("/dashboard/settings", window.location.origin);
    targetUrl.searchParams.set("tab", "billing");
    targetUrl.searchParams.set("payment", "success");
    if (trackId) targetUrl.searchParams.set("trackId", trackId);
    if (status) targetUrl.searchParams.set("status", status);

    if (authenticated) {
      router.replace(targetUrl.toString());
    } else {
      const loginUrl = new URL("/login", window.location.origin);
      loginUrl.searchParams.set(
        "returnTo",
        targetUrl.pathname + targetUrl.search,
      );
      router.replace(loginUrl.toString());
    }
  }, [ready, authenticated, router, searchParams]);

  return (
    <div className="flex h-screen w-full items-center justify-center bg-[#0A0A0A]">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="relative">
          <CheckCircle className="h-12 w-12 text-green-500" />
          <Loader2 className="absolute -bottom-1 -right-1 h-5 w-5 animate-spin text-white/60" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-mono text-white">Payment Received</h1>
          <p className="text-sm text-white/60 font-mono">
            Redirecting to your dashboard...
          </p>
        </div>
      </div>
    </div>
  );
}

export default function PaymentSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen w-full items-center justify-center bg-[#0A0A0A]">
          <Loader2 className="h-8 w-8 animate-spin text-white/60" />
        </div>
      }
    >
      <PaymentSuccessContent />
    </Suspense>
  );
}
