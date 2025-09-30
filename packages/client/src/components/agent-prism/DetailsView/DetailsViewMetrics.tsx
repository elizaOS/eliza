import type { TraceSpan } from "@evilmartians/agent-prism-types";

import { getDurationMs, formatDuration } from "@evilmartians/agent-prism-data";
import { Coins } from "lucide-react";

import { Badge } from "../Badge";
import {
  getSpanCategoryIcon,
  getSpanCategoryLabel,
  getSpanCategoryTheme,
} from "../shared.ts";
import { TimestampBadge } from "../TimestampBadge.tsx";

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

      <Badge
        iconStart={<Coins className="size-2.5" />}
        theme="gray"
        size="4"
        label={data.tokensCount}
      />

      <Badge theme="gray" size="4" label={`$ ${data.cost}`} />

      <span className="text-xs text-gray-500 dark:text-gray-600">
        LATENCY: {formatDuration(durationMs)}
      </span>

      {typeof data.startTime === "number" && (
        <TimestampBadge timestamp={data.startTime} />
      )}
    </div>
  );
};
