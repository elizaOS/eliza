/**
 * Main landing page component.
 *
 * Web: Shows landing page for anonymous users, redirects authenticated to dashboard.
 */

"use client";

import { CloudSkyBackground } from "@elizaos/ui";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
// import DiscoverAgents from "./discover-agents";
import { toast } from "sonner";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import LandingHeader from "../layout/landing-header";
import Footer from "./Footer";
import HeroSection from "./hero-section";

interface LandingPageProps {
  accessError?: string;
}

export function LandingPage({ accessError }: LandingPageProps) {
  const { ready, authenticated } = useSessionAuth();
  const navigate = useNavigate();
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
      navigate("/dashboard/agents", { replace: true });
    }
  }, [ready, authenticated, navigate]);

  // Still loading
  if (!ready) return null;

  // Web: Show loading while redirecting authenticated users
  if (authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center flex-col gap-2">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>Opening Eliza Cloud...</span>
      </div>
    );
  }

  // Web: Show landing page for anonymous users
  return (
    <CloudSkyBackground
      className="flex h-screen"
      contentClassName="flex w-full"
      intensity="hero"
    >
      <div className="relative flex w-full flex-col overflow-y-scroll sm:scrollbar-thin sm:scrollbar-thumb-accent sm:scrollbar-track-bg sm:scrollbar-thumb-rounded-full sm:scrollbar-track-rounded-full">
        <LandingHeader />

        {/* Hero Chat Input - fills available viewport space above the footer */}
        <div className="flex-1 flex items-center justify-center py-12">
          <HeroSection />
        </div>

        {/* Discover Sections */}
        {/* <DiscoverApps /> */}
        {/* <DiscoverAgents /> */}

        <Footer />
      </div>
    </CloudSkyBackground>
  );
}
