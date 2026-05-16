/**
 * Landing header component for the landing page.
 * Displays different UI for authenticated vs unauthenticated users with navigation links.
 */

"use client";

import { Button, ElizaCloudLockup, ProductSwitcher } from "@elizaos/ui";
import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import UserMenu from "./user-menu";

const appUrl = import.meta.env.VITE_ELIZA_APP_URL || "https://eliza.app";
const osUrl = import.meta.env.VITE_ELIZA_OS_URL || "https://elizaos.ai";

const productLinks = [
  { label: "ElizaOS", href: osUrl },
  { label: "Eliza App", href: appUrl },
  { label: "Eliza Cloud", href: "/", active: true },
  { label: "Docs", href: "/docs" },
];

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

        <ProductSwitcher
          activeClassName="bg-white text-[#0c4f8d]"
          className="hidden border-white/22 bg-white/14 text-white/76 lg:flex"
          inactiveClassName="hover:bg-white/18 hover:text-white"
          items={productLinks.map((link) => ({
            ...link,
            external:
              !link.href.startsWith("/") && !link.href.includes("localhost"),
          }))}
        />

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
                className="text-base font-[family-name:var(--font-body)]"
              >
                <Link to="/login">Log in</Link>
              </Button>
              <Button
                size="sm"
                onClick={handleGetStarted}
                disabled={!ready}
                className="font-[family-name:var(--font-body)]"
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
