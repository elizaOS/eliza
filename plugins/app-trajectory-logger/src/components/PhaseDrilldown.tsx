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

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted/60">{children}</div>;
}

function jsonBlock(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
  return (
    <div className="flex flex-col gap-2 text-xs">
      {decision ? (
        <div>
          <span className="font-semibold text-txt">{decision.decision}</span>
          {decision.reasoning ? (
            <span className="ml-2 text-muted">{decision.reasoning}</span>
          ) : null}
        </div>
      ) : respond ? (
        <Empty>(no decision parsed)</Empty>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {ctx.length === 0 ? (
          <Empty>no providers</Empty>
        ) : (
          [...new Set(ctx.map((p) => p.providerName).filter(Boolean))].map(
            (n) => (
              <span
                key={n}
                className="rounded-full border border-border/24 bg-card/40 px-1.5 py-0.5 text-2xs text-txt"
              >
                {n}
              </span>
            ),
          )
        )}
      </div>
    </div>
  );
}

function PlanBody({ calls }: { calls: UILlmCall[] }) {
  if (calls.length === 0) return <Empty>no plan calls</Empty>;
  const last = calls[calls.length - 1];
  const text = previewResponseText((last.response ?? "").trim());
  return (
    <div className="flex flex-col gap-2 text-xs">
      {last.actionType ? (
        <div className="font-mono text-txt">{last.actionType}</div>
      ) : null}
      {text ? (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/24 bg-bg/40 p-2 text-2xs text-muted">
          {text}
        </pre>
      ) : (
        <Empty>(empty response)</Empty>
      )}
    </div>
  );
}

// LLM responses can be huge embedding vectors or other dense numeric payloads
// that bury anything useful. Trim to a sensible preview without copying the
// whole array into the DOM.
function previewResponseText(text: string): string {
  if (text.length <= 600) return text;
  return `${text.slice(0, 600)}…  (${text.length - 600} more chars)`;
}

function ActionBody({ events }: { events: UIToolEvent[] }) {
  if (events.length === 0) return <Empty>no actions</Empty>;
  return (
    <div className="flex flex-col gap-2 text-xs">
      {events.map((e) => {
        const name = e.actionName || e.toolName || e.name || "(unknown)";
        const errored =
          e.type === "tool_error" || e.error || e.success === false;
        const ok =
          e.type === "tool_result" ||
          e.status === "completed" ||
          e.success === true;
        const args = e.args ?? e.input ?? null;
        const result = e.result ?? e.output ?? null;
        return (
          <div
            key={e.id}
            className="rounded border border-border/24 bg-card/30 p-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-txt">{name}</span>
              <span
                className={[
                  "text-2xs uppercase",
                  errored
                    ? "text-red-400"
                    : ok
                      ? "text-green-400"
                      : "text-blue-400",
                ].join(" ")}
              >
                {errored ? "error" : ok ? "ok" : "running"}
                {typeof e.durationMs === "number" ? ` · ${e.durationMs}ms` : ""}
              </span>
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
  if (events.length === 0 && calls.length === 0)
    return <Empty>no evaluators</Empty>;
  return (
    <div className="flex flex-col gap-2 text-xs">
      {events.map((e) => {
        const name = e.evaluatorName || e.name || "evaluator";
        const errored = e.error || e.success === false;
        return (
          <div
            key={e.id}
            className="rounded border border-border/24 bg-card/30 p-2"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-txt">{name}</span>
              <span
                className={[
                  "text-2xs uppercase",
                  errored ? "text-red-400" : "text-green-400",
                ].join(" ")}
              >
                {e.decision ?? (errored ? "error" : "ok")}
              </span>
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
      {events.length === 0 && calls.length > 0 ? (
        <Empty>{calls.length} eval llm calls</Empty>
      ) : null}
    </div>
  );
}
