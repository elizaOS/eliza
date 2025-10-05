import type { TraceSpan } from '@evilmartians/agent-prism-types';

import { Badge } from '../Badge.tsx';
import { PriceBadge } from '../PriceBadge.tsx';
import { getSpanCategoryIcon, getSpanCategoryLabel, getSpanCategoryTheme } from '../shared.ts';
import { TokensBadge } from '../TokensBadge.tsx';

interface SpanCardBagdesProps {
  data: TraceSpan;
}

export const SpanCardBadges = ({ data }: SpanCardBagdesProps) => {
  const Icon = getSpanCategoryIcon(data.type);

  return (
    <div className="flex flex-wrap items-center justify-start gap-1">
      <Badge
        iconStart={<Icon className="size-2.5" />}
        theme={getSpanCategoryTheme(data.type)}
        size="4"
        label={getSpanCategoryLabel(data.type)}
      />

      {typeof data.tokensCount === 'number' && <TokensBadge tokensCount={data.tokensCount} />}

      {typeof data.cost === 'number' && <PriceBadge cost={data.cost} />}
    </div>
  );
};
