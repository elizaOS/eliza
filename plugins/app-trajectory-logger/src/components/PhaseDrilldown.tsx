import type {
  UIEvaluationEvent,
  UILlmCall,
  UIProviderAccess,
  UIToolEvent,
} from "../api-client";
import { extractShouldRespondDecision, type PhaseSummary } from "../phases";

export function PhaseDrilldown({ phase }: { phase: PhaseSummary }) {
  switch (phase.phase) {
    case "HANDLE":
      return <HandleBody calls={phase.llmCalls} ctx={phase.providerAccesses} />;
    case "PLAN":
      return <PlanBody calls={phase.llmCalls} />;
    case "ACTION":
      return <ActionBody events={phase.toolEvents} />;
    case "EVALUATE":
      return (
        <EvaluateBody calls={phase.llmCalls} events={phase.evaluationEvents} />
      );
  }
}

const STATUS_BORDER: Record<"ok" | "error" | "running" | "skipped", string> = {
  ok: "border-green-500/40",
  error: "border-red-500/40",
  running: "border-blue-500/40 animate-pulse",
  skipped: "border-yellow-500/40",
};

function jsonBlock(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewText(text: string): string {
  if (text.length <= 600) return text;
  return `${text.slice(0, 600)}…  (+${text.length - 600})`;
}

function HandleBody({
  calls,
  ctx,
}: {
  calls: UILlmCall[];
  ctx: UIProviderAccess[];
}) {
  const respond = calls.find(
    (c) => (c.stepType || c.purpose || "").toLowerCase() === "should_respond",
  );
  const decision = respond ? extractShouldRespondDecision(respond) : null;
  const providers = [
    ...new Set(ctx.map((p) => p.providerName).filter(Boolean)),
  ];
  return (
    <div className="flex flex-col gap-2 text-xs">
      {decision ? (
        <div>
          <span className="font-semibold text-txt">{decision.decision}</span>
          {decision.reasoning ? (
            <span className="ml-2 text-muted">{decision.reasoning}</span>
          ) : null}
        </div>
      ) : null}
      {providers.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {providers.map((n) => (
            <span
              key={n}
              className="rounded-full border border-border/24 bg-card/40 px-1.5 py-0.5 text-2xs text-txt"
            >
              {n}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PlanBody({ calls }: { calls: UILlmCall[] }) {
  const last = calls[calls.length - 1];
  if (!last) return null;
  const text = previewText((last.response ?? "").trim());
  return (
    <div className="flex flex-col gap-2 text-xs">
      {last.actionType ? (
        <div className="font-mono text-txt">{last.actionType}</div>
      ) : null}
      {text ? (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/24 bg-bg/40 p-2 text-2xs text-muted">
          {text}
        </pre>
      ) : null}
    </div>
  );
}

function ActionBody({ events }: { events: UIToolEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 text-xs">
      {events.map((e) => {
        const name = e.actionName || e.toolName || e.name || "action";
        const status: keyof typeof STATUS_BORDER =
          e.type === "tool_error" || e.error || e.success === false
            ? "error"
            : e.type === "tool_result" ||
                e.status === "completed" ||
                e.success === true
              ? "ok"
              : e.status === "skipped"
                ? "skipped"
                : "running";
        const args = e.args ?? e.input ?? null;
        const result = e.result ?? e.output ?? null;
        return (
          <div
            key={e.id}
            className={[
              "rounded border-l-2 bg-card/30 p-2",
              STATUS_BORDER[status],
            ].join(" ")}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-txt">{name}</span>
              {typeof e.durationMs === "number" ? (
                <span className="text-2xs text-muted/60">{e.durationMs}ms</span>
              ) : null}
            </div>
            {e.error ? (
              <div className="mt-1 text-2xs text-red-400">{e.error}</div>
            ) : null}
            {args && Object.keys(args).length > 0 ? (
              <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg/40 p-1 text-2xs text-muted">
                {jsonBlock(args)}
              </pre>
            ) : null}
            {result !== null && result !== undefined ? (
              <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-bg/40 p-1 text-2xs text-muted">
                {jsonBlock(result)}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function EvaluateBody({
  calls,
  events,
}: {
  calls: UILlmCall[];
  events: UIEvaluationEvent[];
}) {
  if (events.length === 0 && calls.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 text-xs">
      {events.map((e) => {
        const name = e.evaluatorName || e.name || "evaluator";
        const status: keyof typeof STATUS_BORDER =
          e.error || e.success === false
            ? "error"
            : e.success === true || e.status === "completed"
              ? "ok"
              : e.status === "skipped"
                ? "skipped"
                : "running";
        return (
          <div
            key={e.id}
            className={[
              "rounded border-l-2 bg-card/30 p-2",
              STATUS_BORDER[status],
            ].join(" ")}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-txt">{name}</span>
              {e.decision ? (
                <span className="text-2xs text-muted">{e.decision}</span>
              ) : null}
            </div>
            {e.thought ? (
              <div className="mt-1 text-muted">{e.thought}</div>
            ) : null}
            {e.error ? (
              <div className="mt-1 text-2xs text-red-400">{e.error}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
