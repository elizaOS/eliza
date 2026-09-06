import { useState } from "react";
import type { TrajectoryDetail } from "../api-client";

/** Full recorded data, mounted only when opened to keep large prompts out of the idle DOM. */
function RecordedData({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-lg border border-border p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer font-medium">{label}</summary>
      {open && (
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </details>
  );
}

export function TrajectoryRecord({ detail }: { detail: TrajectoryDetail }) {
  const { trajectory } = detail;
  const stages = [...(detail.semanticStages ?? [])].sort(
    (a, b) => a.startedAt - b.startedAt,
  );
  const start = trajectory.startTime;
  return (
    <section aria-label="Recorded trajectory" className="min-w-0 space-y-3">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">Recorded turn</h2>
        <p className="break-all font-mono text-xs">{trajectory.id}</p>
        <p className="text-sm text-muted-foreground">
          {trajectory.status} · {trajectory.durationMs ?? "Unknown"} ms total
          trace · {detail.llmCalls.length} model calls
        </p>
      </header>
      <p className="text-sm text-muted-foreground">
        Server recordings, not browser first-token or audio latency. Total trace
        time can include work after the reply. Model calls may be nested inside
        stages: do not add overlapping durations. Gaps are not attributed
        without instrumentation.
      </p>
      {stages.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm tabular-nums">
            <caption className="sr-only">
              Stage timings relative to trace start
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th className="p-2">Stage</th>
                <th className="p-2">Start</th>
                <th className="p-2">End</th>
                <th className="p-2">Duration</th>
              </tr>
            </thead>
            <tbody>
              {stages.map((stage) => (
                <tr key={stage.stageId} className="border-b border-border">
                  <th className="p-2 font-normal">{stage.kind}</th>
                  <td className="p-2">
                    {start == null
                      ? "Unknown"
                      : `+${stage.startedAt - start} ms`}
                  </td>
                  <td className="p-2">
                    {start == null || stage.endedAt == null
                      ? "Unknown"
                      : `+${stage.endedAt - start} ms`}
                  </td>
                  <td className="p-2">
                    {stage.latencyMs == null
                      ? "Unknown"
                      : `${stage.latencyMs} ms`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm">
          No semantic stage timings were recorded for this turn.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm tabular-nums">
          <caption className="py-2 text-left font-medium">
            All model-call timings, including calls outside the stage table
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th className="p-2">Purpose</th>
              <th className="p-2">Recorded at</th>
              <th className="p-2">Duration</th>
              <th className="p-2">Tokens in / out</th>
            </tr>
          </thead>
          <tbody>
            {detail.llmCalls.map((call) => (
              <tr key={call.id} className="border-b border-border">
                <th className="p-2 font-normal">
                  {call.purpose || call.stepType || "Unclassified"}
                </th>
                <td className="p-2">
                  {start == null || call.timestamp == null
                    ? "Unknown"
                    : `+${call.timestamp - start} ms`}
                </td>
                <td className="p-2">
                  {call.latencyMs == null ? "Unknown" : `${call.latencyMs} ms`}
                </td>
                <td className="p-2">
                  {call.promptTokens ?? "Unknown"} /{" "}
                  {call.completionTokens ?? "Unknown"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted-foreground">
        Prompts and tool results may contain private conversation data. Inspect
        locally; review before sharing. Missing fields mean not recorded, not
        zero.
      </p>
      {stages.map((stage, index) => (
        <RecordedData
          key={stage.stageId}
          label={`${index + 1}. ${stage.kind}: recorded inputs and outputs`}
          value={stage}
        />
      ))}
      <RecordedData
        label={`All model calls (${detail.llmCalls.length})`}
        value={detail.llmCalls}
      />
      <RecordedData
        label={`Provider accesses (${detail.providerAccesses.length})`}
        value={detail.providerAccesses}
      />
      <RecordedData
        label="Tool and evaluation events"
        value={{
          toolEvents: detail.toolEvents,
          evaluationEvents: detail.evaluationEvents,
        }}
      />
      <RecordedData label="Complete API record (JSON)" value={detail} />
    </section>
  );
}
