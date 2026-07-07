/**
 * Presentational pieces of the inline task pipeline: the live plan/todo
 * checklist, one sub-agent's activity block (its current line + collapsible
 * tool steps), and the mapping that lets a `SwarmActivityTool` reuse the
 * existing `ToolCallEventLog` card. Consumed by `task-widget.tsx` (the `[TASK]`
 * card) and `inline-builtins` (the standalone `[CHECKLIST]` widget). State comes
 * from `task-activity-store`; these components only render it — no fetching.
 */

import type {
  SwarmActivityPlanEntry,
  SwarmActivityStatus,
} from "@elizaos/core";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePlay,
  CircleX,
  type LucideIcon,
  Square,
  SquareCheck,
} from "lucide-react";
import { memo } from "react";
import type { NativeToolCallEvent } from "../../../api/client-types-cloud";
import type {
  SubagentActivity,
  TaskActivityStep,
} from "../../../state/task-activity-store";
import { ToolCallEventLog } from "../../tool-events/ToolCallEventLog";
import { ChatWidgetShell } from "./chat-widget-shell";
import { planChecklistPropsEqual } from "./widget-equality";

const STATUS_ICON: Record<SwarmActivityStatus, LucideIcon> = {
  running: CirclePlay,
  success: CircleCheck,
  failure: CircleX,
  waiting: CircleAlert,
  idle: CircleDashed,
};

const STATUS_TONE: Record<SwarmActivityStatus, string> = {
  running: "text-ok",
  success: "text-ok",
  failure: "text-danger",
  waiting: "text-warn",
  idle: "text-muted",
};

const STATUS_LABEL: Record<SwarmActivityStatus, string> = {
  running: "running",
  success: "done",
  failure: "failed",
  waiting: "waiting",
  idle: "idle",
};

/** A running sub-agent pulses its status dot; terminal ones hold steady. */
function StatusDot({ status }: { status: SwarmActivityStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center ${STATUS_TONE[status]}`}
      role="img"
      aria-label={STATUS_LABEL[status]}
      title={STATUS_LABEL[status]}
    >
      <Icon
        className={`h-3.5 w-3.5 ${status === "running" ? "animate-pulse" : ""}`}
      />
    </span>
  );
}

/**
 * Bridge a stream tool step to the trajectory `ToolCallEventLog` shape so the
 * inline step reuses the exact card the debug view uses (issue #13536 §(a)).
 */
export function toNativeToolEvent(step: TaskActivityStep): NativeToolCallEvent {
  const t = step.tool;
  const type: NativeToolCallEvent["type"] =
    t.status === "failure"
      ? "tool_error"
      : t.status === "success"
        ? "tool_result"
        : "tool_call";
  return {
    id: step.id,
    type,
    timestamp: step.timestamp,
    toolCallId: t.id ?? step.id,
    toolName: t.title ?? t.kind ?? "tool",
    ...(t.rawInput ? { input: t.rawInput } : {}),
    ...(t.output !== undefined ? { output: t.output } : {}),
    status:
      t.status === "success"
        ? "completed"
        : t.status === "failure"
          ? "failed"
          : "running",
    ...(t.status === "failure" && t.output ? { error: t.output } : {}),
  };
}

/**
 * Live plan/todo checklist that mutates in place. `pending` -> `in_progress` ->
 * `completed` are three distinguishable renders (issue #13536 §todos).
 *
 * Memoized on the entries by value (see `planChecklistPropsEqual`): the
 * standalone `[CHECKLIST]` inline widget re-parses on every streamed token, so
 * without a value-level comparator each token would re-render this list even
 * when no entry status changed. Entry-status advancement is still a real change
 * and re-renders.
 */
export const PlanChecklist = memo(function PlanChecklist({
  entries,
  title,
}: {
  entries: SwarmActivityPlanEntry[];
  title?: string;
}) {
  if (entries.length === 0) return null;
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <div data-testid="plan-checklist" className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{title ?? "Checklist"}</span>
        <span className="tabular-nums">
          {done}/{entries.length}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry, i) => {
          const isDone = entry.status === "completed";
          const isActive = entry.status === "in_progress";
          const Icon = isDone ? SquareCheck : isActive ? CircleDashed : Square;
          return (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: plan entries have no stable id; content+index is stable within a snapshot render.
              key={`${i}-${entry.content}`}
              data-status={entry.status}
              className={`flex items-start gap-2 text-sm ${
                isDone
                  ? "text-muted line-through"
                  : isActive
                    ? "text-txt"
                    : "text-txt/80"
              }`}
            >
              <Icon
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                  isDone
                    ? "text-ok"
                    : isActive
                      ? "animate-pulse text-accent"
                      : "text-muted"
                }`}
              />
              <span className="min-w-0 flex-1 break-words">
                {entry.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}, planChecklistPropsEqual);

export const ChecklistWidget = memo(function ChecklistWidget({
  entries,
  title,
}: {
  entries: SwarmActivityPlanEntry[];
  title?: string;
}) {
  if (entries.length === 0) return null;
  const done = entries.filter((e) => e.status === "completed").length;
  const complete = done === entries.length;
  const resolvedTitle = title ?? "Checklist";
  return (
    <ChatWidgetShell
      title={resolvedTitle}
      status={
        <span className="rounded-sm bg-bg px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted">
          {done}/{entries.length}
        </span>
      }
      summary={`${done}/${entries.length} complete`}
      complete={complete}
      testId="checklist-widget-shell"
    >
      <div className="px-3 py-2">
        <PlanChecklist entries={entries} title={resolvedTitle} />
      </div>
    </ChatWidgetShell>
  );
}, planChecklistPropsEqual);

/**
 * One sub-agent under a task: its status + current streamed line, its live plan
 * (if any), and its tool steps as collapsible rows. Indented one level when it
 * is a nested child session.
 */
export function SubagentBlock({ agent }: { agent: SubagentActivity }) {
  const currentLine = agent.currentText ?? agent.currentReasoning;
  return (
    <div
      data-testid="subagent-block"
      data-session-id={agent.sessionId}
      data-status={agent.status}
      className={`flex flex-col gap-1.5 ${
        agent.parentSessionId ? "ml-4 border-l border-border pl-3" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={agent.status} />
        <span className="truncate text-sm font-medium text-txt">
          {agent.label ?? agent.sessionId.slice(0, 8)}
        </span>
        <span className={`text-xs ${STATUS_TONE[agent.status]}`}>
          {STATUS_LABEL[agent.status]}
        </span>
      </div>
      {currentLine ? (
        <div className="ml-6 truncate text-xs text-muted" title={currentLine}>
          {agent.currentText ? currentLine : `Thinking: ${currentLine}`}
        </div>
      ) : null}
      {agent.plan && agent.plan.length > 0 ? (
        <div className="ml-6">
          <PlanChecklist entries={agent.plan} title="Plan" />
        </div>
      ) : null}
      {agent.steps.length > 0 ? (
        <div className="ml-6 flex flex-col gap-1.5">
          {agent.steps.map((step) => (
            <ToolCallEventLog key={step.id} event={toNativeToolEvent(step)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export {
  STATUS_ICON as PIPELINE_STATUS_ICON,
  STATUS_TONE as PIPELINE_STATUS_TONE,
};
