import {
  flattenSpans,
} from "@evilmartians/agent-prism-data";
import {
  type TraceRecord,
  type TraceSpan,
} from "@evilmartians/agent-prism-types";
import { filterSpansRecursively } from "@/lib/agent-prism-utils";
import cn from "classnames";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { BadgeProps } from "./Badge";
import type { SpanCardViewOptions } from "./SpanCard/SpanCard";

import { Button } from "./Button";
import {
  CollapseAllButton,
  ExpandAllButton,
} from "./CollapseAndExpandControls";
import { DetailsView } from "./DetailsView/DetailsView";
import { SearchInput } from "./SearchInput";
import { TraceList } from "./TraceList/TraceList";
import { TraceListItemHeader } from "./TraceList/TraceListItemHeader";
import { TreeView } from "./TreeView";

export interface TraceViewerData {
  traceRecord: TraceRecord;
  badges?: Array<BadgeProps>;
  spans: TraceSpan[];
  spanCardViewOptions?: SpanCardViewOptions;
}

export interface TraceViewerProps {
  data: Array<TraceViewerData>;
  spanCardViewOptions?: SpanCardViewOptions;
}

export const TraceViewer = ({ data }: TraceViewerProps) => {
  const [selectedTrace, setSelectedTrace] = useState<
    TraceRecordWithDisplayData | undefined
  >(data[0].traceRecord);
  const [selectedTraceSpans, setSelectedTraceSpans] = useState<TraceSpan[]>(
    data[0].spans,
  );
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | undefined>(
    data[0].spans[0].children?.[0],
  );
  const [searchValue, setSearchValue] = useState("");

  const [traceListExpanded, setTraceListExpanded] = useState(true);

  const traceRecords: TraceRecordWithDisplayData[] = useMemo(() => {
    return data.map((item) => ({
      ...item.traceRecord,
      badges: item.badges,
      spanCardViewOptions: item.spanCardViewOptions,
    }));
  }, [data]);

  const filteredSpans = useMemo(() => {
    if (!searchValue.trim()) {
      return selectedTraceSpans;
    }

    return filterSpansRecursively(selectedTraceSpans, searchValue);
  }, [selectedTraceSpans, searchValue]);

  const allIds = useMemo(() => {
    return flattenSpans(selectedTraceSpans).map((span) => span.id);
  }, [selectedTraceSpans]);

  const [expandedSpansIds, setExpandedSpansIds] = useState<string[]>(allIds);

  useEffect(() => {
    setExpandedSpansIds(allIds);
  }, [allIds]);

  const handleExpandAll = useCallback(() => {
    setExpandedSpansIds(allIds);
  }, [allIds]);

  const handleCollapseAll = useCallback(() => {
    setExpandedSpansIds([]);
  }, []);

  useEffect(() => {
    setSelectedSpan(selectedTraceSpans[0]);
  }, [selectedTraceSpans]);

  const handleTraceSelect = useCallback(
    (trace: TraceRecord) => {
      setSelectedTrace(trace);
      setSelectedTraceSpans(
        data.find((item) => item.traceRecord.id === trace.id)?.spans ?? [],
      );
    },
    [data],
  );

  const props: LayoutProps = {
    traceRecords,
    traceListExpanded,
    setTraceListExpanded,
    selectedTrace,
    setSelectedTrace,
    selectedTraceSpans,
    setSelectedTraceSpans,
    selectedSpan,
    setSelectedSpan,
    searchValue,
    setSearchValue,
    filteredSpans,
    expandedSpansIds,
    setExpandedSpansIds,
    handleExpandAll,
    handleCollapseAll,
    handleTraceSelect,
  };

  return (
    <div className="h-full w-full p-4 lg:p-8">
      <div className="hidden lg:block">
        <DesktopLayout {...props} />
      </div>

      <div className="lg:hidden">
        <MobileLayout {...props} />
      </div>
    </div>
  );
};

interface TraceRecordWithDisplayData extends TraceRecord {
  spanCardViewOptions?: SpanCardViewOptions;
  badges?: BadgeProps[];
}

interface LayoutProps {
  traceRecords: TraceRecordWithDisplayData[];
  traceListExpanded: boolean;
  setTraceListExpanded: (expanded: boolean) => void;
  selectedTrace: TraceRecordWithDisplayData | undefined;
  setSelectedTrace: (trace: TraceRecordWithDisplayData | undefined) => void;
  selectedTraceSpans: TraceSpan[];
  setSelectedTraceSpans: (spans: TraceSpan[]) => void;
  selectedSpan: TraceSpan | undefined;
  setSelectedSpan: (span: TraceSpan | undefined) => void;
  searchValue: string;
  setSearchValue: (value: string) => void;
  filteredSpans: TraceSpan[];
  expandedSpansIds: string[];
  setExpandedSpansIds: (ids: string[]) => void;
  handleExpandAll: () => void;
  handleCollapseAll: () => void;
  handleTraceSelect: (trace: TraceRecord) => void;
}

const DesktopLayout = ({
  traceRecords,
  traceListExpanded,
  setTraceListExpanded,
  selectedTrace,
  selectedSpan,
  setSelectedSpan,
  searchValue,
  setSearchValue,
  filteredSpans,
  expandedSpansIds,
  setExpandedSpansIds,
  handleExpandAll,
  handleCollapseAll,
  handleTraceSelect,
}: LayoutProps) => {
  return (
    <div
      className={cn(
        "grid gap-4",
        traceListExpanded
          ? "grid-cols-[20%_1fr_30%]"
          : "grid-cols-[min-content_1fr_30%]",
      )}
    >
      <TraceList
        traces={traceRecords}
        expanded={traceListExpanded}
        onExpandStateChange={setTraceListExpanded}
        onTraceSelect={handleTraceSelect}
        selectedTrace={selectedTrace}
      />

      {selectedTrace ? (
        <div className="flex flex-col gap-4">
          <TraceListItemHeader trace={selectedTrace} />

          <div className="rounded border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
            <div className="flex items-center justify-between gap-2 border-b border-gray-200 p-3 dark:border-gray-800">
              <SearchInput
                id="span-search-desktop"
                name="search"
                onClear={() => setSearchValue("")}
                value={searchValue}
                onValueChange={setSearchValue}
                className="max-w-60 grow"
              />

              <div className="flex items-center gap-2">
                <div className="ml-auto flex items-center gap-3">
                  <ExpandAllButton onExpandAll={handleExpandAll} />
                  <CollapseAllButton onCollapseAll={handleCollapseAll} />
                </div>
              </div>
            </div>

            {filteredSpans.length === 0 ? (
              <div className="p-3 text-center text-gray-600 dark:text-gray-200">
                No spans found
              </div>
            ) : (
              <TreeView
                spans={filteredSpans}
                onSpanSelect={setSelectedSpan}
                selectedSpan={selectedSpan}
                expandedSpansIds={expandedSpansIds}
                onExpandSpansIdsChange={setExpandedSpansIds}
                spanCardViewOptions={selectedTrace.spanCardViewOptions}
              />
            )}
          </div>
        </div>
      ) : (
        <Placeholder title="Select a trace to see the details" />
      )}

      {selectedSpan ? (
        <DetailsView data={selectedSpan} />
      ) : (
        <Placeholder title="Select a span to see the details" />
      )}
    </div>
  );
};

const MobileLayout = ({
  traceRecords,
  traceListExpanded,
  setTraceListExpanded,
  selectedTrace,
  setSelectedTrace,
  selectedTraceSpans,
  setSelectedTraceSpans,
  selectedSpan,
  setSelectedSpan,
  searchValue,
  setSearchValue,
  filteredSpans,
  expandedSpansIds,
  setExpandedSpansIds,
  handleExpandAll,
  handleCollapseAll,
  handleTraceSelect,
}: LayoutProps) => {
  if (!selectedTrace) {
    return (
      <TraceList
        traces={traceRecords}
        expanded={traceListExpanded}
        onExpandStateChange={setTraceListExpanded}
        onTraceSelect={handleTraceSelect}
        selectedTrace={selectedTrace}
      />
    );
  }

  if (selectedTrace && selectedTraceSpans.length && !selectedSpan) {
    return (
      <div className="flex flex-col gap-4">
        <Button
          onClick={() => {
            setSelectedTrace(undefined);
            setSelectedTraceSpans([]);
          }}
          iconStart={<ArrowLeft className="size-3" />}
          variant="ghost"
          className="self-start"
        >
          Traces list
        </Button>

        <TraceListItemHeader trace={selectedTrace} />

        <div className="rounded border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="flex items-center justify-between gap-2 border-b border-gray-200 p-3 dark:border-gray-800">
            <SearchInput
              id="span-search-mobile"
              name="search"
              onClear={() => setSearchValue("")}
              value={searchValue}
              onValueChange={setSearchValue}
              className="max-w-60 grow"
            />

            <div className="flex items-center gap-2">
              <div className="ml-auto flex items-center gap-3">
                <ExpandAllButton onExpandAll={handleExpandAll} />
                <CollapseAllButton onCollapseAll={handleCollapseAll} />
              </div>
            </div>
          </div>

          {filteredSpans.length === 0 ? (
            <div className="p-3 text-center text-gray-600 dark:text-gray-200">
              No spans found
            </div>
          ) : (
            <TreeView
              spans={filteredSpans}
              spanCardViewOptions={selectedTrace.spanCardViewOptions}
              onSpanSelect={setSelectedSpan}
              selectedSpan={selectedSpan}
              expandedSpansIds={expandedSpansIds}
              onExpandSpansIdsChange={setExpandedSpansIds}
            />
          )}
        </div>
      </div>
    );
  }

  if (selectedTrace && selectedTraceSpans.length && selectedSpan) {
    return (
      <div className="flex flex-col gap-4">
        <Button
          onClick={() => {
            setSelectedSpan(undefined);
          }}
          iconStart={<ArrowLeft className="size-3" />}
          variant="ghost"
          className="self-start"
        >
          Tree View
        </Button>

        <DetailsView data={selectedSpan} />
      </div>
    );
  }

  return null;
};

interface PlaceholderProps {
  title: string;
}

const Placeholder = ({ title }: PlaceholderProps) => {
  return (
    <p className="hidden items-center justify-center rounded-lg bg-gray-100 p-4 text-center text-gray-600 lg:flex dark:bg-gray-900 dark:text-gray-200">
      {title}
    </p>
  );
};
