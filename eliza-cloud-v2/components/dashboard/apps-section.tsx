/**
 * Apps section component displaying user's applications on the dashboard.
 * Shows up to 4 apps with a "View all" link if more exist.
 *
 * @param props - Apps section configuration
 * @param props.apps - Array of app objects to display
 * @param props.className - Additional CSS classes
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { BrandButton } from "@/components/brand";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Sparkles, Activity, Users, Info } from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { QuickCreateDialog } from "@/components/builders";

interface App {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  app_url: string;
  logo_url: string | null;
  is_active: boolean;
  total_users: number;
  total_requests: number;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AppsSectionProps {
  apps: App[];
  className?: string;
}

export function AppsSection({ apps = [], className }: AppsSectionProps) {
  // Show max 4 apps on dashboard
  const displayApps = apps.slice(0, 4);
  const hasMore = apps.length > 4;
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  return (
    <div className={cn("space-y-4", className)}>
      {/* Section Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/apps"
              className="text-xl font-semibold text-white transition-colors duration-200 hover:text-orange-500"
            >
              Apps
            </Link>
            <span className="text-base text-white/50">({apps.length})</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-white/40 hover:text-white/70 transition-colors"
                >
                  <Info className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                className="max-w-[180px] text-xs bg-zinc-900 text-white/80 border border-white/10"
              >
                Third-party applications that integrate with Eliza Cloud.
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {hasMore && (
          <BrandButton
            variant="outline"
            asChild
            size="sm"
            className="h-8 text-xs"
          >
            <Link href="/dashboard/apps">View All</Link>
          </BrandButton>
        )}
      </div>

      {/* Apps Content */}
      {apps.length === 0 ? (
        <AppsEmptyState onBuildWithAI={() => setShowCreateDialog(true)} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {displayApps.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      )}

      <QuickCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        defaultType="app"
      />
    </div>
  );
}

// Individual App Card
function AppCard({ app }: { app: App }) {
  return (
    <Link href={`/dashboard/apps/${app.id}`} className="block h-full">
      <div className="group relative h-full overflow-hidden rounded-xl bg-white/5 border border-white/10 transition-all duration-300 hover:border-white/20 hover:bg-white/[0.07]">
        {/* Header */}
        <div className="p-4 pb-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-white truncate">{app.name}</h3>
            <Badge
              className={
                app.is_active
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px] px-1.5 py-0 shrink-0 ml-2"
                  : "bg-zinc-500/20 text-zinc-400 border-zinc-500/30 text-[10px] px-1.5 py-0 shrink-0 ml-2"
              }
            >
              {app.is_active ? "Active" : "Inactive"}
            </Badge>
          </div>
          <p className="text-xs text-white/50 line-clamp-2 leading-relaxed min-h-[2.5rem]">
            {app.description || "No description"}
          </p>
        </div>

        {/* Stats */}
        <div className="px-4 py-3 border-t border-white/5">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1 text-white/40">
                <Users className="h-3 w-3 text-blue-400" />
                <span>{app.total_users.toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1 text-white/40">
                <Activity className="h-3 w-3 text-purple-400" />
                <span>{app.total_requests.toLocaleString()}</span>
              </div>
            </div>
            <span className="text-white/30">
              Updated{" "}
              {formatDistanceToNow(new Date(app.updated_at)).replace(
                "about ",
                "",
              )}{" "}
              ago
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

// Empty State
function AppsEmptyState({ onBuildWithAI }: { onBuildWithAI: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[160px] md:min-h-[240px] gap-4 bg-neutral-900 rounded-xl">
      <h3 className="text-lg font-medium text-neutral-500">No apps yet</h3>
      <BrandButton
        onClick={onBuildWithAI}
        className="h-9 md:h-10 bg-[#FF5800] text-white hover:bg-[#FF5800]/90 active:bg-[#FF5800]/80"
      >
        <Sparkles className="h-4 w-4" />
        Build with AI
      </BrandButton>
    </div>
  );
}

// Skeleton Loader
export function AppsSectionSkeleton() {
  return (
    <div className="space-y-4">
      {/* Section Header Skeleton */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-16 bg-white/10 animate-pulse rounded" />
          <div className="h-5 w-8 bg-white/10 animate-pulse rounded" />
        </div>
        <div className="h-8 w-20 bg-white/10 animate-pulse rounded" />
      </div>

      {/* Apps Grid Skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {[...Array(4)].map((_, index) => (
          <div
            key={index}
            className="overflow-hidden rounded-xl bg-white/5 border border-white/10"
          >
            {/* Header skeleton */}
            <div className="p-4 pb-3">
              <div className="flex items-center justify-between mb-2">
                <div className="h-5 w-24 bg-white/10 animate-pulse rounded" />
                <div className="h-4 w-14 bg-white/10 animate-pulse rounded" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3 w-full bg-white/10 animate-pulse rounded" />
                <div className="h-3 w-2/3 bg-white/10 animate-pulse rounded" />
              </div>
            </div>
            {/* Stats skeleton */}
            <div className="px-4 pb-4 pt-2 border-t border-white/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-3 w-10 bg-white/10 animate-pulse rounded" />
                  <div className="h-3 w-10 bg-white/10 animate-pulse rounded" />
                </div>
                <div className="h-3 w-16 bg-white/10 animate-pulse rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
