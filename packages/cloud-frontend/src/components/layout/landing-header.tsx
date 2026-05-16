/**
 * Minimal public header. The landing page owns the visual background.
 */

"use client";

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";
import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import UserMenu from "./user-menu";

export default function LandingHeader() {
  const { ready, authenticated } = useSessionAuth();
  const navigate = useNavigate();

  const launchEliza = () => navigate("/login?intent=launch");
  const openDashboard = () => navigate("/login?intent=dashboard");

  return (
    <motion.header className="pointer-events-auto fixed top-0 left-0 z-[100] w-full bg-transparent">
      <div className="flex h-16 items-center justify-between w-full px-6 sm:px-8 lg:px-12">
        <Link to="/" className="flex items-center gap-3">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudBlack}`}
            alt="eliza cloud"
            className="h-7 w-auto sm:h-8"
            draggable={false}
          />
        </Link>

        <div className="flex items-center gap-3">
          {authenticated ? (
            <>
              <Link
                to="/dashboard/agents"
                className="inline-flex min-h-11 items-center justify-center bg-black px-5 text-sm font-medium text-white transition-colors hover:bg-[#0B35F1]"
              >
                Launch Eliza
              </Link>
              <Link
                to="/dashboard"
                className="hidden min-h-11 items-center justify-center bg-[#FF5800] px-5 text-sm font-medium text-black transition-colors hover:bg-black hover:text-white sm:inline-flex"
              >
                Developer Dashboard
              </Link>
              <UserMenu />
            </>
          ) : (
            <>
              <button
                aria-disabled={!ready}
                className="inline-flex min-h-11 items-center justify-center bg-black px-5 text-sm font-medium text-white transition-colors hover:bg-[#0B35F1] disabled:opacity-50"
                onClick={launchEliza}
                disabled={!ready}
                type="button"
              >
                Launch Eliza
              </button>
              <button
                className="hidden min-h-11 items-center justify-center bg-[#FF5800] px-5 text-sm font-medium text-black transition-colors hover:bg-black hover:text-white disabled:opacity-50 sm:inline-flex"
                onClick={openDashboard}
                disabled={!ready}
                type="button"
              >
                Developer Dashboard
              </button>
            </>
          )}
        </div>
      </div>
    </motion.header>
  );
}
