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

const appUrl = import.meta.env.VITE_ELIZA_APP_URL || "https://eliza.app";
const osUrl = import.meta.env.VITE_ELIZA_OS_URL || "https://elizaos.ai";

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

  if (!ready) return null;

  if (authenticated) {
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

      <section className="brand-section brand-section--black">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-3">
          <div>
            <p className="mb-3 text-sm font-bold uppercase tracking-widest text-white/60">
              Always on
            </p>
            <h3 className="mb-3 text-3xl font-bold leading-tight">
              Cloud-hosted agents
            </h3>
            <p className="text-base leading-relaxed text-white/80">
              Spin up an Eliza agent that lives in the cloud, online 24/7,
              answering messages, running tasks, and learning while you sleep.
            </p>
          </div>
          <div>
            <p className="mb-3 text-sm font-bold uppercase tracking-widest text-white/60">
              Yours to keep
            </p>
            <h3 className="mb-3 text-3xl font-bold leading-tight">
              You own the agent
            </h3>
            <p className="text-base leading-relaxed text-white/80">
              Migrate between cloud and your own hardware whenever you want.
              The agent, its memory, and its skills travel with you.
            </p>
          </div>
          <div>
            <p className="mb-3 text-sm font-bold uppercase tracking-widest text-white/60">
              Built to earn
            </p>
            <h3 className="mb-3 text-3xl font-bold leading-tight">
              Monetize what you build
            </h3>
            <p className="text-base leading-relaxed text-white/80">
              Publish apps, agents, and MCP servers. Earn from inference
              markups and creator revenue share.
            </p>
          </div>
        </div>
      </section>

      <section
        className="brand-section brand-section--orange"
        style={{ paddingTop: "5rem", paddingBottom: "5rem" }}
      >
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <h2
              className="text-[clamp(2.25rem,5vw,4rem)] font-extrabold leading-[0.95] text-black"
              style={{ fontFamily: "Poppins, system-ui, sans-serif" }}
            >
              Get the Eliza app.
            </h2>
            <p className="mt-4 max-w-xl text-lg leading-snug text-black/80">
              The desktop and mobile companion for your agent. Voice, chat,
              and connectors — everything routes back to your cloud.
            </p>
          </div>
          <a
            href={appUrl}
            className="inline-flex min-h-14 items-center justify-center bg-black px-9 py-4 text-base font-semibold text-white transition hover:bg-black/85 sm:text-lg"
            style={{ borderRadius: 0 }}
          >
            Download the app →
          </a>
        </div>
      </section>

      <section
        className="brand-section brand-section--blue"
        style={{ paddingTop: "5rem", paddingBottom: "5rem" }}
      >
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-2xl">
            <h2
              className="text-[clamp(2.25rem,5vw,4rem)] font-extrabold leading-[0.95] text-white"
              style={{ fontFamily: "Poppins, system-ui, sans-serif" }}
            >
              Install elizaOS.
            </h2>
            <p className="mt-4 max-w-xl text-lg leading-snug text-white/85">
              The open-source agent runtime. Run it on your own hardware, your
              own VPS, or your own pocket.
            </p>
          </div>
          <a
            href={osUrl}
            className="inline-flex min-h-14 items-center justify-center bg-white px-9 py-4 text-base font-semibold text-[#0b35f1] transition hover:bg-white/90 sm:text-lg"
            style={{ borderRadius: 0 }}
          >
            Install elizaOS →
          </a>
        </div>
      </section>

      <Footer />
    </div>
  );
}
