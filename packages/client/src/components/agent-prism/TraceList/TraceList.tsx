import type { TraceRecord } from "@evilmartians/agent-prism-types";

import cn from "classnames";
import { ArrowLeft } from "lucide-react";

import { Badge, type BadgeProps } from "../Badge.tsx";
import { IconButton } from "../IconButton.tsx";
import { TraceListItem } from "./TraceListItem.tsx";

type TraceRecordWithBadges = TraceRecord & {
  badges?: Array<BadgeProps>;
};

type TraceListProps = {
  traces: TraceRecordWithBadges[];
  expanded: boolean;
  onExpandStateChange: (expanded: boolean) => void;
  className?: string;
  onTraceSelect?: (trace: TraceRecord) => void;
  selectedTrace?: TraceRecord;
};

export const TraceList = ({
  traces,
  expanded,
  onExpandStateChange,
  className,
  onTraceSelect,
  selectedTrace,
}: TraceListProps) => {
  return (
    <div
      className={cn(
        "w-full min-w-0",
        "flex flex-col gap-3",
        expanded ? "w-full" : "w-fit",
        className,
      )}
    >
      <header className="flex min-h-6 items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2
            className={cn(
              "font-regular text-base text-gray-950 dark:text-gray-200",
              !expanded && "hidden",
            )}
          >
            Traces
          </h2>

          <Badge
            size="5"
            theme="gray"
            aria-label={`Total number of traces: ${traces.length}`}
            label={traces.length}
          />
        </div>

        <IconButton
          aria-label={expanded ? "Collapse Trace List" : "Expand Trace List"}
          onClick={() => onExpandStateChange(!expanded)}
          className="lg:hidden"
        >
          <ArrowLeft
            className={cn(
              "size-3 transition-transform",
              expanded ? "" : "rotate-180",
            )}
          />
        </IconButton>
      </header>

      {expanded && (
        <ul className="flex flex-col items-center overflow-hidden rounded border border-gray-200 dark:border-gray-800">
          {traces.map((trace) => (
            <li
              className="w-full list-none border-b-gray-200 dark:border-b-gray-900 [&:not(:last-child)]:border-b"
              key={trace.id}
            >
              <TraceListItem
                trace={trace}
                onClick={() => onTraceSelect?.(trace)}
                isSelected={selectedTrace?.id === trace.id}
                badges={trace.badges}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
