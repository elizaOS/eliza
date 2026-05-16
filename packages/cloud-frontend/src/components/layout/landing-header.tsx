/**
 * Minimal public header. The landing page owns the visual background.
 */

"use client";

import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import UserMenu from "./user-menu";

export default function LandingHeader() {
  const { ready, authenticated } = useSessionAuth();
  const navigate = useNavigate();

  const runInCloud = () => navigate("/login?intent=signup");

  return (
    <motion.header className="pointer-events-auto fixed top-0 left-0 z-[100] w-full bg-transparent">
      <div className="flex h-16 items-center justify-between w-full px-6 sm:px-8 lg:px-12">
        <Link to="/" className="flex items-center gap-3">
          <img
            src="/brand/logos/elizacloud_logotext.svg"
            alt="eliza cloud"
            className="h-7 w-auto sm:h-8"
            draggable={false}
          />
        </Link>

        <div className="flex items-center gap-3">
          {authenticated ? (
            <>
              <Link
                to="/dashboard"
                className="inline-flex min-h-11 items-center justify-center bg-white px-5 text-sm font-medium text-black transition-colors hover:bg-[#FF5800]"
              >
                Dashboard
              </Link>
              <UserMenu />
            </>
          ) : (
            <>
              <Link
                aria-disabled={!ready}
                className="inline-flex min-h-11 items-center justify-center px-2 text-sm font-medium text-white transition-colors hover:text-[#FF5800]"
                to="/login"
              >
                Sign in
              </Link>
              <button
                className="inline-flex min-h-11 items-center justify-center bg-white px-5 text-sm font-medium text-black transition-colors hover:bg-[#FF5800] disabled:opacity-50"
                onClick={runInCloud}
                disabled={!ready}
                type="button"
              >
                Run in Cloud
              </button>
            </>
          )}
        </div>
      </div>
    </motion.header>
  );
}
