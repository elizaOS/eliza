/**
 * Main landing page component.
 *
 * Shows landing page for anonymous users, redirects authenticated to dashboard.
 */

"use client";

import LandingHeader from "@/components/layout/landing-header-old";
import TopHero from "@/components/landing/TopHero-old";
import OnChainTrust from "@/components/landing/OnChainTrust";
import Installation from "@/components/landing/Installation";
import Footer from "@/components/landing/Footer";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import BayerDitheringBackground from "./BayerDitheringBackground";
import { toast } from "sonner";

interface LandingPageProps {
  accessError?: string;
}

export function LandingPage({ accessError }: LandingPageProps) {
  const { ready, authenticated } = usePrivy();
  const router = useRouter();
  const hasRedirectedRef = useRef(false);
  const errorShownRef = useRef(false);

  // Show access error toast
  useEffect(() => {
    if (accessError && !errorShownRef.current) {
      errorShownRef.current = true;

      if (accessError === "private_character") {
        toast.error("This agent is private", {
          description:
            "Sign in to access your agents, or ask the owner to make this agent public.",
          duration: 6000,
        });
      }

      // Clear error from URL
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("error");
        window.history.replaceState({}, "", url.toString());
      }
    }
  }, [accessError]);

  useEffect(() => {
    if (!ready || hasRedirectedRef.current) return;

    // Redirect authenticated users to dashboard
    if (authenticated) {
      hasRedirectedRef.current = true;
      router.replace("/dashboard");
    }
  }, [ready, authenticated, router]);

  // Still loading
  if (!ready) return null;

  // Show loading while redirecting authenticated users
  if (authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-2">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>Redirecting to dashboard...</span>
      </div>
    );
  }

  // Web: Show landing page for anonymous users
  return (
    <div className="flex h-screen bg-black">
      <BayerDitheringBackground />

      <div className="relative z-30 flex w-full flex-col overflow-y-scroll sm:scrollbar-thin sm:scrollbar-thumb-brand-orange sm:scrollbar-track-black">
        <LandingHeader />

        <TopHero />
        <OnChainTrust />
        <Installation />
        <Footer />
      </div>
    </div>
  );
}
