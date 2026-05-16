/**
 * Main landing page component.
 *
 * Web: Shows landing page for anonymous users, redirects authenticated to dashboard.
 */

"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
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

      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("error");
        window.history.replaceState({}, "", url.toString());
      }
    }
  }, [accessError]);

  useEffect(() => {
    if (!ready || hasRedirectedRef.current) return;
    if (authenticated) {
      hasRedirectedRef.current = true;
      navigate("/dashboard/agents", { replace: true });
    }
  }, [ready, authenticated, navigate]);

  // Render the landing page on SSR and during client auth-loading so the SSR
  // markup matches the client first paint (avoids React #418 hydration error).
  // The useEffect above swaps in /dashboard/agents once we know the user is
  // authenticated.
  if (ready && authenticated) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-black text-white">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>Opening Eliza Cloud…</span>
      </div>
    );
  }

  return (
    <div className="theme-cloud flex min-h-screen w-full flex-col bg-black text-white">
      <LandingHeader />
      <HeroSection />
      <Footer />
    </div>
  );
}
