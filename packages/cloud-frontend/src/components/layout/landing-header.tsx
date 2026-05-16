/**
 * Landing header component for the cloud landing page.
 * Keeps the nav quiet so the primary cloud CTA stays focused.
 */

"use client";

import { Button, ElizaCloudLockup } from "@elizaos/ui";
import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import UserMenu from "./user-menu";

export default function LandingHeader() {
  const { ready, authenticated } = useSessionAuth();
  const navigate = useNavigate();

  // No auto-redirect - let users stay on landing page even when logged in

  const handleGetStarted = () => {
    navigate("/login?intent=signup");
  };

  return (
    <motion.header className="fixed top-0 left-0 z-[100] w-full pointer-events-auto bg-bg/70 backdrop-blur-md md:bg-transparent md:backdrop-blur-none">
      <div className="flex h-16 items-center justify-between w-full px-6 sm:px-8 lg:px-12">
        <Link to="/" className="flex items-center gap-3">
          <ElizaCloudLockup />
        </Link>

        <div className="flex items-center gap-3">
          {authenticated ? (
            <>
              {/* Authenticated user - show Dashboard + UserMenu */}
              <Button size="sm">
                <Link to="/dashboard">Dashboard</Link>
              </Button>
              <UserMenu />
            </>
          ) : (
            <>
              {/* Unauthenticated - show Login + Sign Up */}
              <Button
                variant="ghost"
                size="sm"
                disabled={!ready}
                className="text-base font-[family-name:var(--font-body)] text-white hover:bg-white/12 hover:text-white"
              >
                <Link to="/login">Log in</Link>
              </Button>
              <Button
                size="sm"
                onClick={handleGetStarted}
                disabled={!ready}
                className="rounded-full border border-white/34 bg-white/12 font-[family-name:var(--font-body)] text-white shadow-[0_12px_36px_rgba(0,24,122,0.24)] backdrop-blur-xl hover:bg-white hover:text-[#0647ff]"
              >
                Open Cloud
              </Button>
            </>
          )}
        </div>
      </div>
    </motion.header>
  );
}
