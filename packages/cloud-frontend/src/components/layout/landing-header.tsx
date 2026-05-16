/**
 * Landing header component for the cloud landing page.
 * Keeps the nav quiet so the primary cloud CTA stays focused.
 */

"use client";

import { Button } from "@elizaos/ui";
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
    <motion.header className="pointer-events-auto fixed top-0 left-0 z-[100] w-full bg-transparent">
      <div className="flex h-16 items-center justify-between w-full px-6 sm:px-8 lg:px-12">
        <Link to="/" className="flex items-center gap-3">
          <img
            src="/brand/logos/elizacloud_logotext_black.svg"
            alt="eliza cloud"
            className="h-7 w-auto"
            draggable={false}
          />
        </Link>

        <div className="flex items-center gap-3">
          {authenticated ? (
            <>
              <Button
                size="sm"
                className="rounded-none bg-black text-white hover:bg-black/85"
              >
                <Link to="/dashboard">Dashboard</Link>
              </Button>
              <UserMenu />
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={!ready}
                className="rounded-none text-base text-black hover:bg-black/10 hover:text-black"
              >
                <Link to="/login">Log in</Link>
              </Button>
              <Button
                size="sm"
                onClick={handleGetStarted}
                disabled={!ready}
                className="rounded-none bg-black text-white hover:bg-black/85"
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
