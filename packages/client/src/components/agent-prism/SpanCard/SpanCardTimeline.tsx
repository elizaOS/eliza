import type { TraceSpan } from "@evilmartians/agent-prism-types";

import { getTimelineData } from "@evilmartians/agent-prism-data";
import { cn } from "@/lib/utils";

import type { ColorVariant } from "../shared.ts";

interface SpanCardTimelineProps {
  spanCard: TraceSpan;
  theme: ColorVariant;
  minStart: number;
  maxEnd: number;
  className?: string;
}

const timelineBgColors: Record<ColorVariant, string> = {
  purple: "bg-purple-400 dark:bg-purple-600",
  indigo: "bg-indigo-400 dark:bg-indigo-600",
  orange: "bg-orange-400 dark:bg-orange-600",
  teal: "bg-teal-400 dark:bg-teal-600",
  cyan: "bg-cyan-400 dark:bg-cyan-600",
  sky: "bg-sky-400 dark:bg-sky-600",
  yellow: "bg-yellow-400 dark:bg-yellow-600",
  emerald: "bg-emerald-400 dark:bg-emerald-600",
  red: "bg-red-400 dark:bg-red-600",
  gray: "bg-gray-400 dark:bg-gray-600",
};

export const SpanCardTimeline = ({
  spanCard,
  theme,
  minStart,
  maxEnd,
  className,
}: SpanCardTimelineProps) => {
  const { startPercent, widthPercent } = getTimelineData({
    spanCard,
    minStart,
    maxEnd,
  });

  return (
    <span
      className={cn(
        "relative flex h-4 min-w-20 flex-1 rounded bg-gray-200 dark:bg-gray-900",
        className,
      )}
    >
      <span className="pointer-events-none absolute inset-x-1 top-1/2 h-1.5 -translate-y-1/2">
        <span
          className={`absolute h-full rounded-sm ${timelineBgColors[theme]}`}
          style={{
            left: `${startPercent}%`,
            width: `${widthPercent}%`,
          }}
        />
      </span>
    </span>
  );
};
