/**
 * Owns the orchestrator task-list filters and compact task metadata projection.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import type {
  CodingAgentOrchestratorStatus,
  CodingAgentTaskThread,
} from "@elizaos/ui/api/client-types-cloud";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@elizaos/ui/components/ui/select";
import { Bot, Pause } from "lucide-react";
import type { ReactNode } from "react";
import {
  FILTER_OPTIONS,
  labelPriority,
  labelStatus,
  PRIORITY_ICON,
  type StatusFilter,
  type Translate,
} from "./orchestrator-workbench-glyphs";
import { TaskMetaChip, TaskStatusChip } from "./TaskCardList";
import { formatIsoRelative, formatRelativeTime } from "./view-format";

export function FilterSelect({
  status,
  active,
  onSelect,
  t,
}: {
  status: CodingAgentOrchestratorStatus | null;
  active: StatusFilter;
  onSelect: (filter: StatusFilter) => void;
  t: Translate;
}) {
  const countFor = (filter: StatusFilter): number => {
    if (!status) return 0;
    if (filter === "all") return status.taskCount;
    return status.byStatus[filter] ?? 0;
  };
  const filterLabel = t("orchestrator.filter.label", {
    defaultValue: "Filter by status",
  });
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "rail-filter-status",
    role: "select",
    label: filterLabel,
    group: "orchestrator-rail",
    description: "Filter the task list by status",
    options: FILTER_OPTIONS,
    getValue: () => active,
    onFill: (value) => {
      if ((FILTER_OPTIONS as string[]).includes(value)) {
        onSelect(value as StatusFilter);
      }
    },
  });
  const labelFor = (filter: StatusFilter) =>
    filter === "all"
      ? t("orchestrator.filter.all", { defaultValue: "All" })
      : labelStatus(filter, t);
  return (
    <Select
      value={active}
      onValueChange={(value) => onSelect(value as StatusFilter)}
    >
      <SelectTrigger
        ref={ref}
        aria-label={filterLabel}
        data-testid="orchestrator-filter"
        className="h-9 border-0 bg-transparent px-1 text-xs"
        {...agentProps}
      >
        <span className="flex items-center gap-2">
          {active !== "all" ? (
            <TaskStatusChip status={active} t={t} />
          ) : (
            <span className="text-txt">{labelFor("all")}</span>
          )}
          <span className="text-muted tabular-nums">({countFor(active)})</span>
        </span>
      </SelectTrigger>
      <SelectContent>
        {FILTER_OPTIONS.map((filter) => (
          <SelectItem key={filter} value={filter} className="text-xs">
            <span className="flex items-center gap-2">
              {filter === "all" ? (
                <span>{labelFor("all")}</span>
              ) : (
                <TaskStatusChip status={filter} t={t} />
              )}
              <span className="text-muted tabular-nums">
                ({countFor(filter)})
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Visual metadata for an orchestrator task row. */
export function orchestratorTaskChips(
  thread: CodingAgentTaskThread,
  t: Translate,
  locale?: string,
): ReactNode {
  const lastActivity =
    thread.latestActivityAt != null
      ? formatRelativeTime(thread.latestActivityAt, locale)
      : formatIsoRelative(
          thread.updatedAt,
          locale,
          t("orchestrator.unknown", { defaultValue: "—" }),
        );
  const PriorityIcon = PRIORITY_ICON[thread.priority];
  return (
    <>
      {thread.sessionCount > 0 ? (
        <TaskMetaChip
          icon={<Bot className="h-3 w-3" />}
          tone={thread.activeSessionCount > 0 ? "accent" : "muted"}
        >
          {t("orchestrator.chip.agents", {
            defaultValue: "{{active}}/{{total}} agents",
            active: thread.activeSessionCount,
            total: thread.sessionCount,
          })}
        </TaskMetaChip>
      ) : null}
      {thread.paused ? (
        <TaskMetaChip icon={<Pause className="h-3 w-3" />}>
          {t("orchestrator.status.paused", { defaultValue: "Paused" })}
        </TaskMetaChip>
      ) : null}
      {PriorityIcon && thread.priority !== "normal" ? (
        <TaskMetaChip icon={<PriorityIcon className="h-3 w-3" />}>
          {labelPriority(thread.priority, t)}
        </TaskMetaChip>
      ) : null}
      <span className="text-2xs text-muted/80">{lastActivity}</span>
    </>
  );
}
