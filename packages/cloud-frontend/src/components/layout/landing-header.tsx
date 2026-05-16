/**
 * Landing / public header. Sticky and transparent on the landing hero,
 * opaque black everywhere else (login, blog, legal, OS, BSC, etc).
 */

"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import UserMenu from "./user-menu";

export default function LandingHeader() {
  const { ready, authenticated } = useSessionAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [scrolled, setScrolled] = useState(false);

  const isLanding = pathname === "/";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const handleGetStarted = () => {
    navigate("/login?intent=signup");
  };

  const transparent = isLanding && !scrolled;
  const logoSrc = "/brand/logos/elizacloud_logotext.svg";

  return (
    <motion.header
      className={`pointer-events-auto fixed top-0 left-0 z-[100] w-full transition-colors duration-200 ${
        transparent ? "bg-transparent" : "bg-black"
      }`}
    >
      <div className="flex h-16 items-center justify-between w-full px-6 sm:px-8 lg:px-12">
        <Link to="/" className="flex items-center gap-3">
          <img
            src={logoSrc}
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
                className="inline-flex min-h-11 items-center justify-center bg-white px-5 text-sm font-semibold text-black transition-colors hover:bg-white/85"
              >
                Dashboard
              </Link>
              <UserMenu />
            </>
          ) : (
            <>
              <Link
                aria-disabled={!ready}
                className="inline-flex min-h-11 items-center justify-center px-2 text-sm font-semibold text-white transition-colors hover:text-[#FF5800]"
                to="/login"
              >
                Sign in
              </Link>
              <button
                className="inline-flex min-h-11 items-center justify-center bg-white px-5 text-sm font-semibold text-black transition-colors hover:bg-white/85 disabled:opacity-50"
                onClick={handleGetStarted}
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
