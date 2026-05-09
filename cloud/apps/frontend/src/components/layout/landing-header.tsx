/**
 * Landing header component for the landing page.
 * Displays different UI for authenticated vs unauthenticated users with navigation links.
 */

"use client";

import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import UserMenu from "./user-menu";
import { ElizaCloudLockup } from "@elizaos/cloud-ui";
import { Button } from "@elizaos/cloud-ui";

export default function LandingHeader() {
  const { ready, authenticated } = useSessionAuth();
  const navigate = useNavigate();

  // No auto-redirect - let users stay on landing page even when logged in

  const handleGetStarted = () => {
    navigate("/login?intent=signup");
  };

  return (
    <motion.header className="fixed top-0 left-0 z-[100] w-full pointer-events-auto bg-black/40 backdrop-blur-md md:bg-transparent md:backdrop-blur-none">
      <div className="flex h-16 items-center justify-between w-full px-6 sm:px-8 lg:px-12">
        <Link to="/" className="flex items-center gap-3">
          <ElizaCloudLockup logoClassName="h-5 sm:h-6" />
        </Link>

        <div className="flex items-center gap-3">
          {authenticated ? (
            <>
              {/* Authenticated user - show Dashboard + UserMenu */}
              <Button size="sm" className="bg-[#FF5800] text-white hover:bg-[#FF5800]/90">
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
                className="text-base text-white hover:text-white hover:bg-white/5 font-[family-name:var(--font-inter)]"
              >
                <Link to="/login">Log in</Link>
              </Button>
              <Button
                size="sm"
                onClick={handleGetStarted}
                disabled={!ready}
                className="bg-[#FF5800] text-white hover:bg-[#FF5800]/90 font-[family-name:var(--font-inter)]"
              >
                Get started
              </Button>
            </>
          )}
        </div>
      </div>
    </motion.header>
  );
}
