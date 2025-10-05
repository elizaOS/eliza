import type { TraceSpan } from '@evilmartians/agent-prism-types';

import { getTimelineData } from '@evilmartians/agent-prism-data';
import { cn } from '@/lib/utils';

import type { ColorVariant } from '../shared.ts';

interface SpanCardTimelineProps {
  spanCard: TraceSpan;
  theme: ColorVariant;
  minStart: number;
  maxEnd: number;
  className?: string;
}

const timelineBgColors: Record<ColorVariant, string> = {
  purple: 'bg-primary',
  indigo: 'bg-primary',
  orange: 'bg-chart-1',
  teal: 'bg-chart-2',
  cyan: 'bg-chart-3',
  sky: 'bg-chart-4',
  yellow: 'bg-chart-5',
  emerald: 'bg-accent',
  red: 'bg-destructive',
  gray: 'bg-muted-foreground',
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
    <span className={cn('relative flex h-4 min-w-20 flex-1 rounded bg-muted', className)}>
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
