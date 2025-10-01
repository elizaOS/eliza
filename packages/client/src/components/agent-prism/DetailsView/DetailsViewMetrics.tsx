import type { TraceSpan } from '@evilmartians/agent-prism-types';

import { getDurationMs, formatDuration } from '@evilmartians/agent-prism-data';
import { Coins } from 'lucide-react';

import { Badge } from '../Badge';
import { getSpanCategoryIcon, getSpanCategoryLabel, getSpanCategoryTheme } from '../shared.ts';
import { TimestampBadge } from '../TimestampBadge.tsx';

interface DetailsViewMetricsProps {
  data: TraceSpan;
}

export const DetailsViewMetrics = ({ data }: DetailsViewMetricsProps) => {
  const Icon = getSpanCategoryIcon(data.type);
  const durationMs = getDurationMs(data);

  return (
    <div className="mb-4 flex flex-wrap items-center justify-start gap-1">
      <Badge
        iconStart={<Icon className="size-2.5" />}
        theme={getSpanCategoryTheme(data.type)}
        size="4"
        label={getSpanCategoryLabel(data.type)}
      />

      {typeof data.tokensCount === 'number' && (
        <Badge
          iconStart={<Coins className="size-2.5" />}
          theme="gray"
          size="4"
          label={data.tokensCount}
        />
      )}

      {typeof data.cost === 'number' && (
        <Badge theme="gray" size="4" label={`$ ${data.cost.toFixed(4)}`} />
      )}

      <span className="text-xs text-muted-foreground">LATENCY: {formatDuration(durationMs)}</span>

      {typeof data.startTime === 'number' && <TimestampBadge timestamp={data.startTime} />}
    </div>
  );
};
