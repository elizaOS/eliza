"use client";

import { BookOpen } from "lucide-react";
import type { StoriesTopic } from "../hooks/useStoriesFeed";

interface DailyTopicBannerProps {
  topic: StoriesTopic;
}

/**
 * DailyTopicBanner — editorial header for the Stories feed.
 *
 * Displays today's daily topic label and summary at the top of the Stories
 * tab, giving users immediate context for the day's narrative focus.
 */
export function DailyTopicBanner({ topic }: DailyTopicBannerProps) {
  return (
    <div className="border-border border-b bg-muted/30 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex-shrink-0 rounded-md bg-primary/10 p-1.5">
          <BookOpen className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">
            Today&apos;s Story
          </p>
          <h2 className="mt-0.5 font-semibold text-foreground text-sm leading-snug">
            {topic.topicLabel}
          </h2>
          {topic.summary && (
            <p className="mt-1 line-clamp-2 text-muted-foreground text-xs leading-relaxed">
              {topic.summary}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
