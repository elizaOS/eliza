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

  const launchEliza = () => navigate("/login?intent=launch");
  const openDashboard = () => navigate("/login?intent=dashboard");

  const launchLabel = t("cloud.landing.launchEliza", {
    defaultValue: "Launch Eliza",
  });
  const devDashboardLabel = t("cloud.landing.developerDashboard", {
    defaultValue: "Developer Dashboard",
  });

  return (
    <motion.header className="pointer-events-auto fixed top-0 left-0 z-[100] w-full bg-transparent">
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
                to="/dashboard/agents"
                className="inline-flex min-h-10 items-center justify-center rounded-sm bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] sm:min-h-11 sm:px-5"
              >
                {launchLabel}
              </Link>
              <Link
                to="/dashboard"
                className="hidden min-h-11 items-center justify-center rounded-sm border border-[var(--accent)] bg-transparent px-5 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-subtle)] sm:inline-flex"
              >
                {devDashboardLabel}
              </Link>
              <UserMenu />
            </>
          ) : (
            <>
              <button
                aria-disabled={!ready}
                className="inline-flex min-h-10 items-center justify-center rounded-sm bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-50 sm:min-h-11 sm:px-5"
                onClick={launchEliza}
                disabled={!ready}
                type="button"
              >
                {launchLabel}
              </button>
              <button
                className="hidden min-h-11 items-center justify-center rounded-sm border border-[var(--accent)] bg-transparent px-5 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-subtle)] disabled:opacity-50 sm:inline-flex"
                onClick={openDashboard}
                disabled={!ready}
                type="button"
              >
                {devDashboardLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </motion.header>
  );
}
