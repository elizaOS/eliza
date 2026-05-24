/**
 * Minimal public header. The landing page owns the visual background.
 */

"use client";

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { useT } from "@/providers/I18nProvider";
import UserMenu from "./user-menu";

export default function LandingHeader() {
  const { ready, authenticated } = useSessionAuth();
  const navigate = useNavigate();
  const t = useT();

  const openDashboard = () => navigate("/login?intent=dashboard");

  const dashboardLabel = t("cloud.landing.dashboard", {
    defaultValue: "Dashboard",
  });

  return (
    <motion.header className="pointer-events-auto fixed top-9 left-0 z-[100] w-full bg-transparent sm:top-10">
      <div className="flex h-16 w-full items-center justify-between px-5 sm:px-8 lg:px-12">
        <Link to="/" className="flex items-center gap-3">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudBlack}`}
            alt="Eliza Cloud"
            className="h-6 w-auto sm:h-8"
            draggable={false}
          />
        </Link>

        <div className="flex items-center gap-3">
          {authenticated ? (
            <>
              <Link
                to="/dashboard"
                className="inline-flex min-h-10 items-center justify-center rounded-[3px] bg-white px-5 text-sm font-medium text-black transition-colors hover:bg-black hover:text-white sm:min-h-11"
              >
                {dashboardLabel}
              </Link>
              <UserMenu />
            </>
          ) : (
            <button
              aria-disabled={!ready}
              className="inline-flex min-h-10 items-center justify-center rounded-[3px] bg-white px-5 text-sm font-medium text-black transition-colors hover:bg-black hover:text-white disabled:opacity-50 sm:min-h-11"
              onClick={openDashboard}
              disabled={!ready}
              type="button"
            >
              {dashboardLabel}
            </button>
          )}
        </div>
      </div>
    </motion.header>
  );
}
