/**
 * Account settings tab component displaying account information and statistics.
 * Shows user ID, account stats, and provides logout functionality.
 *
 * @param props - Account tab configuration
 * @param props.user - User data with organization information
 * @param props.onTabChange - Callback to switch to other settings tabs
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { ArrowUpRight, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useStewardAuth } from "@/lib/hooks/use-session-auth";
import { useChatStore } from "@/lib/stores/chat-store";
import type { UserWithOrganizationDto } from "@/types/cloud-api";
import type { SettingsTab } from "../types";

interface AccountStats {
  totalGenerations: number;
  totalGenerationsBreakdown: {
    images: number;
    videos: number;
  };
  apiCalls24h: number;
  apiCalls24hSuccessful: number;
  imageGenerationsAllTime: number;
  videoRendersAllTime: number;
}

interface AccountTabProps {
  user: UserWithOrganizationDto;
  onTabChange: (tab: SettingsTab) => void;
}

export function AccountTab({ user, onTabChange }: AccountTabProps) {
  const [isCopying, setIsCopying] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [isLoadingStats, setIsLoadingStats] = useState(true);
  const { isAuthenticated: stewardAuthenticated, signOut: stewardSignOut } = useStewardAuth();
  const navigate = useNavigate();
  const { clearChatData } = useChatStore();

  useEffect(() => {
    const fetchStats = async () => {
      const response = await fetch("/api/stats/account");
      const data = await response.json();

      if (data.success) {
        setStats(data.data);
      }
      setIsLoadingStats(false);
    };

    fetchStats();
  }, []);

  const handleCopyOrgId = async () => {
    if (isCopying) return;
    setIsCopying(true);

    await navigator.clipboard.writeText(user.organization_id || "");
    toast.success("Organization ID copied to clipboard");
    setTimeout(() => setIsCopying(false), 1000);
  };

  const handleLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);

    // Clear chat data (rooms, entityId, localStorage)
    clearChatData();

    if (stewardAuthenticated) {
      stewardSignOut();
      await fetch("/api/auth/steward-session", {
        method: "DELETE",
      }).catch(() => {});
    }

    await fetch("/api/auth/logout", {
      method: "POST",
    });

    toast.success("Logged out successfully");

    window.location.href = "/";
  };

  const handleContactSupport = () => {
    // Support contact logic
    window.location.href = "mailto:support@eliza.cloud";
  };

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Hero Section with Stats */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-4 md:space-y-6">
          {/* Hero Content */}
          <div className="flex flex-col lg:flex-row items-start justify-between gap-4 w-full">
            <div className="flex flex-col gap-2 max-w-xl">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
                <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">
                  Build, deploy, and monitor your ai agents
                </h3>
              </div>
              <p className="text-xs md:text-sm font-mono text-[#858585] tracking-tight">
                Stay on top of credits, observe generation activity, and jump into tools you use the
                most. All from one streamlined dashboard.
              </p>
            </div>

            {/* CTA Buttons */}
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full lg:w-auto">
              <button
                type="button"
                onClick={() => {
                  navigate("/dashboard/account");
                }}
                className="relative bg-[#e1e1e1] px-4 py-2.5 overflow-hidden group hover:bg-white transition-colors flex items-center justify-center gap-2 w-full sm:w-auto"
              >
                <div
                  className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
                  style={{
                    backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                    backgroundSize: "2.915576934814453px 2.915576934814453px",
                  }}
                />
                <span className="relative z-10 text-black font-mono font-medium text-sm md:text-base whitespace-nowrap">
                  Manage account
                </span>
                <ArrowUpRight className="relative z-10 h-[18px] w-[18px] text-black flex-shrink-0" />
              </button>

              <button
                type="button"
                onClick={() => onTabChange("analytics")}
                className="backdrop-blur-sm bg-[rgba(10,10,10,0.5)] border border-[#e1e1e1] px-4 py-2.5 hover:bg-[rgba(255,255,255,0.05)] transition-colors w-full sm:w-auto"
              >
                <span className="text-[#e1e1e1] font-mono font-medium text-sm md:text-base whitespace-nowrap">
                  View analytics
                </span>
              </button>
            </div>
          </div>

          {/* Stats Grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-0">
            <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface p-3 md:p-4 space-y-1">
              <p className="text-xs md:text-sm lg:text-base font-mono text-white">
                Total Generations
              </p>
              <p className="text-xl md:text-2xl font-mono text-white tracking-tight">
                {isLoadingStats ? "..." : stats?.totalGenerations.toLocaleString() || 0}
              </p>
              <p className="text-xs md:text-sm text-white/60">
                {isLoadingStats
                  ? "..."
                  : `${stats?.totalGenerationsBreakdown.images || 0} images, ${stats?.totalGenerationsBreakdown.videos || 0} videos`}
              </p>
            </div>

            <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface p-3 md:p-4 space-y-1">
              <p className="text-xs md:text-sm lg:text-base font-mono text-white">
                API Calls (24h)
              </p>
              <p className="text-xl md:text-2xl font-mono text-white tracking-tight">
                {isLoadingStats ? "..." : stats?.apiCalls24h.toLocaleString() || 0}
              </p>
              <p className="text-xs md:text-sm text-white/60">
                {isLoadingStats
                  ? "..."
                  : `${stats?.apiCalls24hSuccessful.toLocaleString() || 0} successfull`}
              </p>
            </div>

            <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t lg:border-t border-r border-b lg:border-l-0 border-brand-surface p-3 md:p-4 space-y-1">
              <p className="text-xs md:text-sm lg:text-base font-mono text-white">
                Image Generations
              </p>
              <p className="text-xl md:text-2xl font-mono text-white tracking-tight">
                {isLoadingStats ? "..." : stats?.imageGenerationsAllTime.toLocaleString() || 0}
              </p>
              <p className="text-xs md:text-sm text-white/60">All time</p>
            </div>

            <div className="backdrop-blur-sm border-t lg:border-t border-r border-b border-brand-surface p-3 md:p-4 space-y-1">
              <p className="text-xs md:text-sm lg:text-base font-mono text-white">Video Renders</p>
              <p className="text-xl md:text-2xl font-mono text-white tracking-tight">
                {isLoadingStats ? "..." : stats?.videoRendersAllTime.toLocaleString() || 0}
              </p>
              <p className="text-xs md:text-sm text-white/60">All time</p>
            </div>
          </div>
        </div>
      </BrandCard>

      {/* Account Actions Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-4 md:space-y-6">
          {/* Section Header */}
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
            <h3 className="text-sm md:text-base font-mono text-[#e1e1e1] uppercase">Account</h3>
          </div>

          {/* Log out of all devices */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4 w-full">
            <p className="text-sm md:text-base font-mono text-white">Log out of all devices</p>
            <button
              type="button"
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="relative bg-[rgba(255,88,0,0.25)] px-4 py-2.5 hover:bg-[rgba(255,88,0,0.35)] transition-colors group disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
            >
              <CornerBrackets size="sm" className="opacity-70" />
              <span className="relative z-10 text-[#FF5800] font-mono font-medium text-sm whitespace-nowrap">
                {isLoggingOut ? "Logging out..." : "Log out"}
              </span>
            </button>
          </div>

          {/* Delete account */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4 w-full">
            <p className="text-sm md:text-base font-mono text-white">Delete account</p>
            <button
              type="button"
              onClick={handleContactSupport}
              className="text-sm md:text-base font-mono text-white underline hover:text-white/80 transition-colors"
            >
              Contact Support
            </button>
          </div>

          {/* Organization ID */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4 w-full">
            <p className="text-sm md:text-base font-mono text-white">Organization ID</p>
            <div className="flex items-center gap-2">
              <div className="border border-[#303030] px-2 py-2 flex items-center gap-2">
                <span className="text-xs md:text-sm text-white font-normal break-all">
                  {user.organization_id || "N/A"}
                </span>
                <button
                  type="button"
                  onClick={handleCopyOrgId}
                  disabled={isCopying}
                  className="hover:text-white transition-colors disabled:opacity-50 flex-shrink-0"
                  title="Copy Organization ID"
                >
                  <Copy className="h-4 w-4 text-[#A2A2A2]" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </BrandCard>
    </div>
  );
}
