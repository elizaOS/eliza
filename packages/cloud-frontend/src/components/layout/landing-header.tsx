/**
 * Landing / public header. Sticky and transparent on the landing hero,
 * opaque black everywhere else (login, blog, legal, OS, BSC, etc).
 */

"use client";

import { Button } from "@elizaos/ui";
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

  // Only the landing route has a light hero. Everything else uses the
  // black brand background, so default to a solid black bar with white text.
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
  const logoSrc = isLanding
    ? "/brand/logos/elizacloud_logotext_black.svg"
    : "/brand/logos/elizacloud_logotext_white.svg";
  const ghostLink = isLanding
    ? "text-black hover:bg-black/10"
    : "text-white hover:bg-white/10";
  const ctaCls = isLanding
    ? "bg-black text-white hover:bg-black/85"
    : "bg-white text-black hover:bg-white/85";

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
            className="h-7 w-auto"
            draggable={false}
          />
        </Link>

        <div className="flex items-center gap-3">
          {authenticated ? (
            <>
              <Button size="sm" className={`rounded-none ${ctaCls}`}>
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
                className={`rounded-none text-base ${ghostLink}`}
              >
                <Link to="/login">Log in</Link>
              </Button>
              <Button
                size="sm"
                onClick={handleGetStarted}
                disabled={!ready}
                className={`rounded-none ${ctaCls}`}
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
