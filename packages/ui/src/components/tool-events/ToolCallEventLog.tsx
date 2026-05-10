import { CheckCircle, ChevronDown, Clock3, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import type { NativeToolCallEvent } from "../../api/client-types-cloud";

export interface ToolCallEventLogProps {
  event: NativeToolCallEvent;
  className?: string;
}

export type ToolCallEventDisplayState = "running" | "success" | "failure";

export function getToolCallEventDisplayState(
  event: NativeToolCallEvent,
): ToolCallEventDisplayState {
  if (event.type === "tool_error" || event.status === "failed" || event.error) {
    return "failure";
  }
  if (
    event.type === "tool_result" ||
    event.status === "completed" ||
    event.success === true
  ) {
    return "success";
  }
  return "running";
}

export function getToolCallName(event: NativeToolCallEvent): string {
  return (
    event.actionName ||
    event.toolName ||
    event.name ||
    event.callId ||
    event.toolCallId ||
    "tool"
  );
}

function previewValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value.trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max = 180): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function StatePill({ state }: { state: ToolCallEventDisplayState }) {
  const styles = {
    running: "border-primary/30 bg-primary/5 text-primary",
    success: "border-success/30 bg-success/5 text-success",
    failure: "border-danger/30 bg-danger/5 text-danger",
  };
  const labels = {
    running: "Running",
    success: "Success",
    failure: "Failure",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] ${styles[state]}`}
    >
      {labels[state]}
    </span>
  );
}

function StateIcon({ state }: { state: ToolCallEventDisplayState }) {
  if (state === "success") return <CheckCircle className="h-4 w-4" />;
  if (state === "failure") return <XCircle className="h-4 w-4" />;
  return <Clock3 className="h-4 w-4" />;
}

function PreviewRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted/70">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-xs-tight text-txt">
        {value}
      </div>
    </div>
  );
}

export function ToolCallEventLog({
  className = "",
  event,
}: ToolCallEventLogProps) {
  const state = getToolCallEventDisplayState(event);
  const actionName = getToolCallName(event);
  const args = event.args ?? event.input;
  const result = event.result ?? event.output ?? event.error;

  return (
    <div
      className={`rounded-lg border border-border/50 bg-bg/40 px-4 py-3 ${className}`}
      data-testid="tool-call-event-log"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`shrink-0 ${
                state === "failure"
                  ? "text-danger"
                  : state === "success"
                    ? "text-success"
                    : "text-primary"
              }`}
            >
              <StateIcon state={state} />
            </span>
            <div className="truncate text-sm font-semibold text-txt">
              {actionName}
            </div>
          </div>
          <div className="mt-1 text-xs-tight text-muted">
            {event.stage ? String(event.stage).replace(/_/g, " ") : "tool"}
            {event.durationMs || event.duration ? (
              <> - {event.durationMs ?? event.duration}ms</>
            ) : null}
          </div>
        </div>
        <StatePill state={state} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <PreviewRow label="Args" value={truncate(previewValue(args))} />
        <PreviewRow label="Result" value={truncate(previewValue(result))} />
      </div>

      <details className="group mt-3">
        <summary className="flex cursor-pointer select-none items-center gap-1 text-xs-tight font-semibold text-muted hover:text-txt">
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
          JSON details
        </summary>
        <pre className="mt-2 max-h-[24rem] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border/40 bg-bg/60 px-3 py-3 text-xs leading-6 text-txt">
          {formatJson(event)}
        </pre>
      </details>
    </div>
  );
}
