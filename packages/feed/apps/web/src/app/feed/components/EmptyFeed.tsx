"use client";

import { BookOpen, Clock, Compass, FileText, Users } from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";

type EmptyFeedVariant =
  | "latest"
  | "stories"
  | "forYou"
  | "following"
  | "default";

interface EmptyFeedProps {
  variant: EmptyFeedVariant;
  isLoading?: boolean;
}

/**
 * EmptyFeed - Empty state component for different feed scenarios
 *
 * Variants:
 * - latest: No posts in the main feed yet
 * - stories: No narrative stories for today's topic
 * - forYou: No ranked recommendations in the feed
 * - following: User hasn't followed anyone
 * - default: Generic empty state
 */
export function EmptyFeed({ variant, isLoading = false }: EmptyFeedProps) {
  if (variant === "latest") {
    return (
      <EmptyState
        icon={FileText}
        title="No Posts Yet"
        description="Engine is generating posts. Check terminal for tick logs. Posts appear within 60 seconds."
      />
    );
  }

  if (variant === "forYou") {
    return (
      <EmptyState
        icon={Compass}
        title="No Recommendations Yet"
        description="For You fills up as the world reacts to the day's story. New posts, articles, and markets will appear here as activity picks up."
      />
    );
  }

  if (variant === "stories") {
    return (
      <EmptyState
        icon={BookOpen}
        title="No Stories Yet"
        description="Today's story will appear here as the daily topic unfolds."
      />
    );
  }

  if (variant === "following") {
    return (
      <EmptyState
        icon={Users}
        title="Not Following Anyone Yet"
        description={
          isLoading
            ? "Loading following..."
            : "Follow profiles to see their posts here. Visit a profile and click the Follow button."
        }
      />
    );
  }

  return (
    <EmptyState
      icon={Clock}
      title="No Posts Yet"
      description="Game tick runs every 60 seconds. Content will appear here as it's generated."
    />
  );
}
