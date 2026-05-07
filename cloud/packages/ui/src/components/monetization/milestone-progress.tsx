/**
 * Milestone progress component showing progress toward withdrawal threshold.
 * Features animated progress bar and celebratory state when milestone is reached.
 */

"use client";

import { CheckCircle2, Target } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

interface MilestoneProgressProps {
  current: number;
  target: number;
  label?: string;
  className?: string;
  showAmount?: boolean;
}

export function MilestoneProgress({
  current,
  target,
  label = "Withdrawal Threshold",
  className,
  showAmount = true,
}: MilestoneProgressProps) {
  const [animatedProgress, setAnimatedProgress] = useState(0);
  const progress = Math.min((current / target) * 100, 100);
  const isComplete = current >= target;

  useEffect(() => {
    // Animate progress bar on mount
    const timeout = setTimeout(() => {
      setAnimatedProgress(progress);
    }, 100);
    return () => clearTimeout(timeout);
  }, [progress]);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-neutral-500 flex items-center gap-1.5">
          <Target className="h-3 w-3" />
          {label}
        </span>
        {showAmount && (
          <span className="text-neutral-400 font-mono">
            ${current.toFixed(2)} / ${target.toFixed(2)}
          </span>
        )}
      </div>

      <div className="relative h-1.5 bg-white/10 rounded-full overflow-hidden">
        {/* Progress bar */}
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out",
            isComplete ? "bg-emerald-500" : "bg-[#FF5800]",
          )}
          style={{ width: `${animatedProgress}%` }}
        />
      </div>

      {/* Status message */}
      <div className="flex items-center justify-between">
        {isComplete ? (
          <span className="text-xs text-emerald-400 flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Ready to withdraw!
          </span>
        ) : (
          <span className="text-xs text-neutral-500">
            ${(target - current).toFixed(2)} more to unlock
          </span>
        )}
        <span className="text-xs font-mono text-neutral-500">{progress.toFixed(0)}%</span>
      </div>
    </div>
  );
}

interface MilestoneCardProps extends MilestoneProgressProps {
  title?: string;
}

export function MilestoneCard({ title = "Withdrawal Progress", ...props }: MilestoneCardProps) {
  const isComplete = props.current >= props.target;

  return (
    <div
      className={cn(
        "p-4 rounded-xl border transition-colors",
        isComplete ? "bg-emerald-500/5 border-emerald-500/30" : "bg-neutral-900 border-white/10",
      )}
    >
      <h4 className="text-sm font-medium text-white mb-3">{title}</h4>
      <MilestoneProgress {...props} />
    </div>
  );
}
