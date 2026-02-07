/**
 * Sidebar bottom panel component displaying user info, credit balance, and settings.
 * Shows sign up CTA for anonymous users and user menu for authenticated users.
 *
 * @param props - Sidebar bottom panel configuration
 * @param props.className - Additional CSS classes
 */

"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useRouter, usePathname } from "next/navigation";
import { UserPlus, LogIn, Settings, LogOut, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { CornerBrackets } from "@/components/brand";
import { useCredits } from "@/lib/providers/CreditsProvider";

interface SidebarBottomPanelProps {
  className?: string;
  isCollapsed?: boolean;
}

export function SidebarBottomPanel({
  className,
  isCollapsed = false,
}: SidebarBottomPanelProps) {
  const { ready, authenticated, user, logout } = usePrivy();
  const router = useRouter();
  const pathname = usePathname();

  // If not authenticated, show sign up/login CTA
  if (!ready || !authenticated || !user) {
    // Don't show anything while checking auth state
    if (!ready) {
      return null;
    }

    // Collapsed view - just show login icon
    // Preserve current page with returnTo parameter (including query params like characterId)
    if (isCollapsed) {
      const currentUrl =
        pathname +
        (typeof window !== "undefined" ? window.location.search : "");
      return (
        <div className={cn("flex justify-center py-3", className)}>
          <button
            onClick={() =>
              router.push(`/login?returnTo=${encodeURIComponent(currentUrl)}`)
            }
            className="p-2 rounded-lg hover:bg-white/10 transition-colors"
            title="Sign Up / Log In"
          >
            <UserPlus className="h-5 w-5 text-white/60" />
          </button>
        </div>
      );
    }

    // Anonymous user CTA panel
    // Include query params (like characterId) to return to exact chat after login
    const fullUrl =
      pathname + (typeof window !== "undefined" ? window.location.search : "");
    return (
      <div className={cn("relative border-t border-white/10", className)}>
        <CornerBrackets size="sm" className="opacity-20" />

        <div className="relative z-10 px-3 py-3">
          <div className="flex flex-col gap-2">
            <p className="text-[10px] text-white/40 mb-1">
              Sign up for full access
            </p>

            <button
              onClick={() =>
                router.push(`/login?returnTo=${encodeURIComponent(fullUrl)}`)
              }
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-[#FF5800] hover:bg-[#FF5800]/90 text-white text-xs font-medium rounded-sm transition-colors"
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span>Sign Up</span>
            </button>

            <button
              onClick={() =>
                router.push(`/login?returnTo=${encodeURIComponent(fullUrl)}`)
              }
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 border border-white/15 hover:bg-white/5 text-white/70 hover:text-white text-xs rounded-sm transition-colors"
            >
              <LogIn className="h-3.5 w-3.5" />
              <span>Log In</span>
            </button>

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
        <button
          onClick={() => router.push("/dashboard/settings")}
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          title="Settings"
        >
          <Settings className="h-5 w-5 text-white/60" />
        </button>
      </div>
    );
  }

  // Authenticated user - return null (handled elsewhere or not needed)
  return null;
}
