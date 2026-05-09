/**
 * Sidebar bottom panel component displaying user info, credit balance, and settings.
 * Shows sign up CTA for anonymous users and user menu for authenticated users.
 *
 * @param props - Sidebar bottom panel configuration
 * @param props.className - Additional CSS classes
 */

"use client";

import { LogIn, Settings, UserPlus } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { cn } from "@/lib/utils";
import { CornerBrackets } from "@elizaos/cloud-ui";

interface SidebarBottomPanelProps {
  className?: string;
  isCollapsed?: boolean;
}

export function SidebarBottomPanel({ className, isCollapsed = false }: SidebarBottomPanelProps) {
  const { ready, authenticated, user } = useSessionAuth();
  const pathname = useLocation().pathname;

  // If not authenticated, show sign up/login CTA
  if (!ready || !authenticated || !user) {
    // Don't show anything while checking auth state
    if (!ready) {
      return null;
    }

    const loginHref = `/login?returnTo=${encodeURIComponent(
      pathname + (typeof window !== "undefined" ? window.location.search : ""),
    )}`;

    // Collapsed view - just show login icon
    // Preserve current page with returnTo parameter (including query params like characterId)
    if (isCollapsed) {
      return (
        <div className={cn("flex justify-center py-3", className)}>
          <Link
            to={loginHref}
            className="border border-white/10 bg-white/5 p-2 transition-colors hover:border-white/20 hover:bg-white/10"
            title="Sign Up / Log In"
          >
            <UserPlus className="h-5 w-5 text-white/60" />
          </Link>
        </div>
      );
    }

    // Anonymous user CTA panel
    // Include query params (like characterId) to return to exact chat after login
    return (
      <div className={cn("relative border-t border-white/10", className)}>
        <CornerBrackets size="sm" className="opacity-20" />

        <div className="relative z-10 px-3 py-3">
          <div className="flex flex-col gap-2">
            <p className="text-[10px] text-white/40 mb-1">Sign up for full access</p>

            <Link
              to={loginHref}
              className="flex w-full items-center justify-center gap-1.5 bg-[#FF5800] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[#FF5800]/90"
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span>Sign Up</span>
            </Link>

            <Link
              to={loginHref}
              className="flex w-full items-center justify-center gap-1.5 border border-white/15 px-3 py-2 text-xs text-white/70 transition-colors hover:bg-white/5 hover:text-white"
            >
              <LogIn className="h-3.5 w-3.5" />
              <span>Log In</span>
            </Link>

            <div className="mt-1 space-y-1 text-[10px] text-white/30">
              <div className="flex items-center gap-1.5">
                <div className="h-1 w-1 rounded-full bg-[#FF5800]/60" />
                <span>Unlimited chats</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-1 w-1 rounded-full bg-[#FF5800]/60" />
                <span>Custom agents</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Authenticated user - collapsed view
  if (isCollapsed) {
    return (
      <div className={cn("flex justify-center py-3", className)}>
        <Link
          to="/dashboard/settings"
          className="border border-white/10 bg-white/5 p-2 transition-colors hover:border-white/20 hover:bg-white/10"
          title="Settings"
        >
          <Settings className="h-5 w-5 text-white/60" />
        </Link>
      </div>
    );
  }

  // Authenticated user - return null (handled elsewhere or not needed)
  return null;
}
