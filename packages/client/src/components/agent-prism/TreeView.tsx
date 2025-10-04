import type { TraceSpan } from '@evilmartians/agent-prism-types';

import { findTimeRange, flattenSpans } from '@evilmartians/agent-prism-data';
import { cn } from '@/lib/utils';
import { type FC } from 'react';

import { SpanCard, type SpanCardViewOptions } from './SpanCard/SpanCard';

interface TreeViewProps {
  spans: TraceSpan[];
  className?: string;
  selectedSpan?: TraceSpan;
  onSpanSelect?: (span: TraceSpan) => void;
  expandedSpansIds: string[];
  onExpandSpansIdsChange: (ids: string[]) => void;
  spanCardViewOptions?: SpanCardViewOptions;
}

export const TreeView: FC<TreeViewProps> = ({
  spans,
  onSpanSelect,
  className = '',
  selectedSpan,
  expandedSpansIds,
  onExpandSpansIdsChange,
  spanCardViewOptions,
}) => {
  const allCards = flattenSpans(spans);

  const { minStart, maxEnd } = findTimeRange(allCards);

  return (
    <div className="w-full min-w-0 p-4">
      <ul
        className={cn(className, 'overflow-x-auto space-y-1')}
        role="tree"
        aria-label="Hierarchical card list"
      >
        {spans.map((span, idx) => (
          <SpanCard
            key={span.id}
            data={span}
            level={0}
            selectedSpan={selectedSpan}
            onSpanSelect={onSpanSelect}
            minStart={minStart}
            maxEnd={maxEnd}
            isLastChild={idx === spans.length - 1}
            expandedSpansIds={expandedSpansIds}
            onExpandSpansIdsChange={onExpandSpansIdsChange}
            viewOptions={spanCardViewOptions}
          />
        ))}
      </ul>
    </div>
  );
};
