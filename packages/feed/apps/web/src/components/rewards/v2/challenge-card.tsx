"use client";

import { Info } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

interface ChallengeCardProps {
  title: string;
  description?: string;
  hint?: string;
  points: number;
  completed: boolean;
  progress?: { current: number; total: number };
  variant?: "daily" | "weekly";
}

export function ChallengeCard({
  title,
  description,
  hint,
  points,
  completed,
  progress,
  variant,
}: ChallengeCardProps) {
  const percentage = progress
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div
      className={`rounded-lg border border-border p-3 transition-all ${
        completed ? "border-emerald-500/20 bg-emerald-500/5" : "bg-card"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {variant && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 font-semibold text-[10px] uppercase tracking-wide ${
                  variant === "daily"
                    ? "bg-blue-500/10 text-blue-500"
                    : "bg-purple-500/10 text-purple-500"
                }`}
              >
                {variant}
              </span>
            )}
            <h3
              className={`font-semibold text-sm ${
                completed ? "text-emerald-500" : "text-foreground"
              }`}
            >
              {title}
            </h3>
            {hint && (
              <Tooltip content={<span className="text-xs">{hint}</span>}>
                <button
                  type="button"
                  aria-label={`Show hint for ${title}`}
                  className="shrink-0 text-muted-foreground/60 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
          </div>
          {description && (
            <p className="mt-0.5 text-muted-foreground text-xs">
              {description}
            </p>
          )}
        </div>
        {completed ? (
          <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 font-bold text-[11px] text-emerald-500">
            +{points} rep ✓
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-bold text-[11px] text-primary">
            +{points} rep
          </span>
        )}
      </div>

      {progress && !completed && (
        <div className="mt-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {progress.current} / {progress.total}
            </span>
            {percentage >= 75 && (
              <span className="font-medium text-[11px] text-amber-500">
                Almost there!
              </span>
            )}
          </div>
          <div className="mt-1 h-1.5 w-full rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${
                percentage >= 67
                  ? "bg-gradient-to-r from-primary to-amber-500"
                  : "bg-primary"
              }`}
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
