"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo } from "react";
import { Avatar } from "@/components/shared/Avatar";
import { Skeleton } from "@/components/shared/Skeleton";
import type { ProfileFormData } from "../hooks/useAgentForm";

interface ProfilePreviewCardProps {
  profileData: ProfileFormData;
  onCycleProfilePic: (direction: "next" | "prev") => void;
  onCycleBanner: (direction: "next" | "prev") => void;
  isLoading?: boolean;
}

export const ProfilePreviewCard = memo(function ProfilePreviewCard({
  profileData,
  onCycleProfilePic,
  onCycleBanner,
  isLoading = false,
}: ProfilePreviewCardProps) {
  if (isLoading) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
        <Skeleton className="aspect-[3/1] w-full" />
        <div className="relative p-4 pt-12">
          <div className="absolute top-0 -translate-y-1/2">
            <Skeleton className="h-20 w-20 rounded-full" />
          </div>
          <div className="mt-2 space-y-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
      {/* Cover Image */}
      <div className="group relative aspect-[3/1] bg-muted">
        {profileData.coverImageUrl ? (
          <img
            src={profileData.coverImageUrl}
            alt="Cover"
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-[#0066FF]/20 to-[#0066FF]/5" />
        )}
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => onCycleBanner("prev")}
            className="rounded-lg bg-background/80 p-1.5 hover:bg-background"
            title="Previous banner"
            type="button"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => onCycleBanner("next")}
            className="rounded-lg bg-background/80 p-1.5 hover:bg-background"
            title="Next banner"
            type="button"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Profile Content */}
      <div className="relative p-4 pt-12">
        {/* Avatar */}
        <div className="group absolute top-0 -translate-y-1/2">
          <Avatar
            id={profileData.username || "placeholder"}
            src={profileData.profileImageUrl || undefined}
            size="lg"
            className="ring-4 ring-background"
          />
          <div className="absolute inset-0 flex items-center justify-center gap-1 rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => onCycleProfilePic("prev")}
              className="rounded-lg bg-background/80 p-1 hover:bg-background"
              title="Previous picture"
              type="button"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button
              onClick={() => onCycleProfilePic("next")}
              className="rounded-lg bg-background/80 p-1 hover:bg-background"
              title="Next picture"
              type="button"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Info */}
        <div className="mt-2">
          <h3 className="font-bold text-lg">
            {profileData.displayName || "Agent Name"}
          </h3>
          <p className="text-muted-foreground text-sm">
            @{profileData.username || "username"}
          </p>

          {profileData.bio && (
            <p className="mt-3 line-clamp-3 text-muted-foreground text-sm">
              {profileData.bio}
            </p>
          )}
        </div>
      </div>
    </div>
  );
});
