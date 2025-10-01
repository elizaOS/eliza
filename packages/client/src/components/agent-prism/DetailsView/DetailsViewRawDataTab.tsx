import type { TraceSpan } from '@evilmartians/agent-prism-types';

import JSONPretty from 'react-json-pretty';

interface RawDataTabProps {
  data: TraceSpan;
}

export const DetailsViewRawDataTab = ({ data }: RawDataTabProps) => (
  <div className="pt-4">
    <div className="rounded border border-border bg-transparent ">
      <JSONPretty
        booleanStyle="color: hsl(var(--primary));"
        className="overflow-x-auto rounded-xl p-4 text-left"
        data={data.raw}
        id={`json-pretty-${data.id || 'span-details'}`}
        keyStyle="color: hsl(var(--primary));"
        mainStyle="color: hsl(var(--muted-foreground)); font-size: 12px;"
        stringStyle="color: hsl(var(--chart-2));"
        valueStyle="color: hsl(var(--chart-1));"
      />
    </div>
  </div>
);
