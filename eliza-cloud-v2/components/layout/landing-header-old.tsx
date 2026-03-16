/**
 * Landing header component for the landing page.
 * Displays different UI for authenticated vs unauthenticated users with navigation links.
 */

"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ElizaLogo } from "@/components/brand";
import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import UserMenu from "@/components/layout/user-menu";
import { motion } from "framer-motion";

export default function LandingHeader() {
  const { ready, authenticated } = usePrivy();
  const router = useRouter();

  // No auto-redirect - let users stay on landing page even when logged in

  const handleGetStarted = () => {
    router.push("/login?intent=signup");
  };

  return (
    <motion.header className="fixed top-0 left-0 z-[100] w-full pointer-events-auto pr-4 sm:pr-[20px] bg-black/40 backdrop-blur-md md:bg-transparent md:backdrop-blur-none">
      <div className="flex h-16 items-center justify-between w-full pl-4">
        <Link href="/" className="flex items-center gap-3">
          <ElizaLogo className="h-5 sm:h-6 text-white shrink-0" />
        </Link>

        <div className="flex items-center gap-3">
          {authenticated ? (
            <>
              {/* Authenticated user - show Dashboard + UserMenu */}
              <Button
                size="sm"
                className="bg-[#FF5800] text-black hover:bg-[#FF5800]/90"
              >
                <Link href="/dashboard">Dashboard</Link>
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
                className="text-base text-white hover:text-white hover:bg-white/5"
              >
                <Link href="/login">Log in</Link>
              </Button>
              <Button
                size="sm"
                onClick={handleGetStarted}
                disabled={!ready}
                className="bg-[#FF5800] text-white hover:bg-[#FF5800]/90"
              >
                Get Started
              </Button>
            </>
          )}
        </div>
      </div>
    </motion.header>
  );
}
