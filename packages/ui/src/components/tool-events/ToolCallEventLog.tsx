/**
 * Renders one native tool-call event (a `NativeToolCallEvent` from the agent's
 * activity stream) as a collapsible log row: a running/success/failure status
 * icon and the tool name, expanding to show the truncated argument/result
 * previews and pretty-printed JSON. State + name derivation live in
 * `ToolCallEventLog.helpers`.
 */
import { CheckCircle, ChevronDown, Clock3, XCircle } from "lucide-react";
import type { ReactNode } from "react";

import type { NativeToolCallEvent } from "../../api/client-types-cloud";
import {
  getToolCallEventDisplayState,
  getToolCallName,
} from "./ToolCallEventLog.helpers";

export interface ToolCallEventLogProps {
  event: NativeToolCallEvent;
  className?: string;
}

export type ToolCallEventDisplayState = "running" | "success" | "failure";

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
  // Plain colored text, no pill chrome: the state color alone carries the
  // signal inside the chat flow (chat-native de-slop).
  const styles = {
    running: "text-primary",
    success: "text-success",
    failure: "text-danger",
  };
  const labels = {
    running: "Running",
    success: "Success",
    failure: "Failure",
  };
  return (
    <span
      className={`inline-flex items-center text-[11px] font-semibold uppercase tracking-[0.12em] ${styles[state]}`}
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
    <div className={`py-1 ${className}`} data-testid="tool-call-event-log">
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
        {/* Keeps the code-block fill (it is code), border dropped. */}
        <pre className="mt-2 max-h-[24rem] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-sm bg-bg/60 px-3 py-3 text-xs leading-6 text-txt">
          {formatJson(event)}
        </pre>
      </details>
    </div>
  );
}
