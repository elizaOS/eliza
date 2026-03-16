/**
 * Main landing page component.
 *
 * Web: Shows landing page for anonymous users, redirects authenticated to dashboard.
 */

"use client";

import LandingHeader from "@/components/layout/landing-header";
import Footer from "@/components/landing/Footer";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import HeroChatInput from "./hero-chat-input";
// import DiscoverApps from "./discover-apps";
// import DiscoverAgents from "./discover-agents";
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

    // Web: Redirect authenticated users to dashboard
    if (authenticated) {
      hasRedirectedRef.current = true;
      router.replace("/dashboard");
    }
  }, [ready, authenticated, router]);

  // Still loading
  if (!ready) return null;

  // Web: Show loading while redirecting authenticated users
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
    <div className="relative flex h-screen bg-black">
      {/* <BayerDitheringBackground /> */}

      {/* Gradient background - Radial gradient version */}
      <div
        className="fixed inset-0 z-10"
        style={{
          backgroundColor: "hsla(167,0%,0%,1)",
          backgroundImage: `
            radial-gradient(at 72% 68%, hsla(6,56%,26%,1) 0px, transparent 50%),
            radial-gradient(at 50% 48%, hsla(10,60%,43%,0.7) 0px, transparent 50%),
            radial-gradient(at 98% 99%, hsla(19,48%,57%,1) 0px, transparent 50%),
            radial-gradient(at 14% 4%, hsla(14,90%,42%,1) 0px, transparent 50%),
            radial-gradient(at 34% 34%, hsla(15,72%,53%,1) 0px, transparent 50%)
          `,
        }}
      >
        {/* Noise overlay */}
        <div
          style={{
            mixBlendMode: "overlay",
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='2' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
            opacity: 1,
          }}
          className="pointer-events-none absolute inset-0 invert z-10"
        />
      </div>

      <div className="relative z-30 flex w-full flex-col overflow-y-scroll sm:scrollbar-thin sm:scrollbar-thumb-brand-orange sm:scrollbar-track-black sm:scrollbar-thumb-rounded-full sm:scrollbar-track-rounded-full">
        <LandingHeader />

        {/* Hero Chat Input - Full screen height section */}
        <div className="min-h-screen flex items-center justify-center pb-12 sm:pb-32">
          <HeroChatInput onSubmit={() => router.push("/login?intent=signup")} />
        </div>

        {/* Discover Sections */}
        {/* <DiscoverApps /> */}
        {/* <DiscoverAgents /> */}

        <Footer />
      </div>
    </div>
  );
}
