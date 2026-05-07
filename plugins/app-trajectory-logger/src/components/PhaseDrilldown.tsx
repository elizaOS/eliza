import type {
  UIEvaluationEvent,
  UILlmCall,
  UIProviderAccess,
  UIToolEvent,
} from "../api-client";
import { extractShouldRespondDecision, type PhaseSummary } from "../phases";

interface PhaseDrilldownProps {
  phase: PhaseSummary;
}

export function PhaseDrilldown({ phase }: PhaseDrilldownProps) {
  switch (phase.phase) {
    case "HANDLE":
      return (
        <HandleDrilldown
          llmCalls={phase.llmCalls}
          providerAccesses={phase.providerAccesses}
        />
      );
    case "PLAN":
      return <PlanDrilldown llmCalls={phase.llmCalls} />;
    case "ACTION":
      return <ActionDrilldown toolEvents={phase.toolEvents} />;
    case "EVALUATE":
      return (
        <EvaluateDrilldown
          llmCalls={phase.llmCalls}
          evaluationEvents={phase.evaluationEvents}
        />
      );
    default:
      return null;
  }
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xs font-semibold uppercase tracking-[0.12em] text-muted/70">
        {title}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border/24 bg-bg/30 px-3 py-2 text-xs text-muted">
      {children}
    </div>
  );
}

function HandleDrilldown({
  llmCalls,
  providerAccesses,
}: {
  llmCalls: UILlmCall[];
  providerAccesses: UIProviderAccess[];
}) {
  const respondCall = llmCalls.find(
    (c) =>
      (c.stepType ?? "").toLowerCase() === "should_respond" ||
      (c.purpose ?? "").toLowerCase() === "should_respond",
  );
  const decision = respondCall
    ? extractShouldRespondDecision(respondCall)
    : null;

  return (
    <div className="flex flex-col gap-4">
      <Section title="Decision to respond">
        {decision ? (
          <div className="rounded-md border border-border/24 bg-card/30 px-3 py-2 text-xs">
            <div className="font-semibold text-txt">{decision.decision}</div>
            {decision.reasoning ? (
              <div className="mt-1 whitespace-pre-wrap text-muted">
                {decision.reasoning}
              </div>
            ) : null}
          </div>
        ) : respondCall ? (
          <div className="rounded-md border border-border/24 bg-card/30 px-3 py-2 text-xs text-muted">
            <pre className="whitespace-pre-wrap break-words">
              {(respondCall.response ?? "").slice(0, 800)}
            </pre>
          </div>
        ) : (
          <EmptyHint>No should-respond call recorded for this turn.</EmptyHint>
        )}
      </Section>
      <Section title={`Contexts (${providerAccesses.length})`}>
        {providerAccesses.length === 0 ? (
          <EmptyHint>No provider accesses captured.</EmptyHint>
        ) : (
          <div className="flex flex-wrap gap-1">
            {providerAccesses.map((p) => (
              <span
                key={p.id}
                title={p.purpose ?? undefined}
                className="rounded-full border border-border/24 bg-card/40 px-2 py-0.5 text-2xs text-txt"
              >
                {p.providerName || "provider"}
              </span>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function PlanDrilldown({ llmCalls }: { llmCalls: UILlmCall[] }) {
  if (llmCalls.length === 0) {
    return <EmptyHint>No planning LLM calls yet.</EmptyHint>;
  }
  const last = llmCalls[llmCalls.length - 1];
  const responseText = (last.response ?? "").trim();
  const actionType = (last.actionType ?? "").trim();

  return (
    <div className="flex flex-col gap-4">
      <Section title="Action chosen">
        {actionType ? (
          <div className="rounded-md border border-border/24 bg-card/30 px-3 py-2 text-xs font-mono text-txt">
            {actionType}
          </div>
        ) : (
          <EmptyHint>
            No actionType tagged on the planning call (this is normal for plain
            replies).
          </EmptyHint>
        )}
      </Section>
      <Section title="Model response">
        <div className="max-h-64 overflow-y-auto rounded-md border border-border/24 bg-card/30 px-3 py-2 text-xs text-muted">
          <pre className="whitespace-pre-wrap break-words">
            {responseText || "(empty)"}
          </pre>
        </div>
      </Section>
      {llmCalls.length > 1 ? (
        <Section title={`Earlier plan calls (${llmCalls.length - 1})`}>
          {llmCalls.slice(0, -1).map((c) => (
            <div
              key={c.id}
              className="rounded-md border border-border/24 bg-bg/40 px-3 py-2 text-2xs text-muted"
            >
              <span className="font-mono text-txt">
                {c.stepType || c.purpose}
              </span>
              <span className="ml-2 opacity-60">{c.model}</span>
            </div>
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function ActionDrilldown({ toolEvents }: { toolEvents: UIToolEvent[] }) {
  if (toolEvents.length === 0) {
    return <EmptyHint>No actions called for this turn.</EmptyHint>;
  }
  return (
    <div className="flex flex-col gap-3">
      {toolEvents.map((event) => {
        const name =
          event.actionName ?? event.toolName ?? event.name ?? "(unknown)";
        const success =
          event.type === "tool_error" || event.error || event.success === false
            ? "error"
            : event.type === "tool_result" ||
                event.status === "completed" ||
                event.success === true
              ? "ok"
              : event.status === "skipped"
                ? "skipped"
                : "running";
        const args = event.args ?? event.input ?? null;
        const result = event.result ?? event.output ?? null;
        return (
          <div
            key={event.id}
            className="rounded-md border border-border/24 bg-card/30 px-3 py-2 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono font-semibold text-txt">{name}</span>
              <ActionStatusBadge status={success} />
            </div>
            {args && Object.keys(args).length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-2xs uppercase tracking-wide text-muted/70">
                  parameters
                </summary>
                <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/16 bg-bg/40 px-2 py-1 text-2xs text-muted">
                  {safeJson(args)}
                </pre>
              </details>
            ) : null}
            {event.error ? (
              <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-2xs text-red-400">
                {event.error}
              </div>
            ) : null}
            {result !== null && result !== undefined ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-2xs uppercase tracking-wide text-muted/70">
                  result
                </summary>
                <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/16 bg-bg/40 px-2 py-1 text-2xs text-muted">
                  {safeJson(result)}
                </pre>
              </details>
            ) : null}
            {typeof event.durationMs === "number" ? (
              <div className="mt-1 text-2xs text-muted/60">
                {event.durationMs}ms
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ActionStatusBadge({
  status,
}: {
  status: "ok" | "error" | "skipped" | "running";
}) {
  const cfg: Record<typeof status, { label: string; className: string }> = {
    ok: {
      label: "ok",
      className: "border-green-500/40 bg-green-500/10 text-green-400",
    },
    error: {
      label: "error",
      className: "border-red-500/40 bg-red-500/10 text-red-400",
    },
    skipped: {
      label: "skipped",
      className: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
    },
    running: {
      label: "running",
      className: "border-blue-500/40 bg-blue-500/10 text-blue-400",
    },
  };
  const c = cfg[status];
  return (
    <span
      className={[
        "rounded-full border px-2 py-0.5 text-2xs uppercase tracking-wide",
        c.className,
      ].join(" ")}
    >
      {c.label}
    </span>
  );
}

function EvaluateDrilldown({
  llmCalls,
  evaluationEvents,
}: {
  llmCalls: UILlmCall[];
  evaluationEvents: UIEvaluationEvent[];
}) {
  if (evaluationEvents.length === 0 && llmCalls.length === 0) {
    return <EmptyHint>No evaluation runs for this turn.</EmptyHint>;
  }
  return (
    <div className="flex flex-col gap-4">
      <Section title={`Evaluators (${evaluationEvents.length})`}>
        {evaluationEvents.length === 0 ? (
          <EmptyHint>No evaluator events.</EmptyHint>
        ) : (
          evaluationEvents.map((event) => (
            <div
              key={event.id}
              className="rounded-md border border-border/24 bg-card/30 px-3 py-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-semibold text-txt">
                  {event.evaluatorName ?? event.name ?? "evaluator"}
                </span>
                <ActionStatusBadge
                  status={
                    event.error || event.success === false
                      ? "error"
                      : event.success === true || event.status === "completed"
                        ? "ok"
                        : event.status === "skipped"
                          ? "skipped"
                          : "running"
                  }
                />
              </div>
              {event.decision ? (
                <div className="mt-1 text-2xs uppercase tracking-wide text-muted/70">
                  decision: <span className="text-txt">{event.decision}</span>
                </div>
              ) : null}
              {event.thought ? (
                <div className="mt-1 whitespace-pre-wrap text-muted">
                  {event.thought}
                </div>
              ) : null}
              {event.error ? (
                <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-2xs text-red-400">
                  {event.error}
                </div>
              ) : null}
            </div>
          ))
        )}
      </Section>
      {llmCalls.length > 0 ? (
        <Section title={`Evaluation LLM calls (${llmCalls.length})`}>
          {llmCalls.map((c) => (
            <div
              key={c.id}
              className="rounded-md border border-border/24 bg-bg/40 px-3 py-2 text-2xs text-muted"
            >
              <span className="font-mono text-txt">
                {c.stepType || c.purpose || "evaluation"}
              </span>
              <span className="ml-2 opacity-60">{c.model}</span>
              {c.response ? (
                <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/16 bg-bg/40 px-2 py-1">
                  {c.response.slice(0, 800)}
                </pre>
              ) : null}
            </div>
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
