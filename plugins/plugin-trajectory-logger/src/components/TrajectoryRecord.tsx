import { useEffect, useState } from "react";
import { fetchTrajectoryTiming, type TrajectoryDetail } from "../api-client";

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

function InferenceTimingRecord({ trajectoryId }: { trajectoryId: string }) {
  const [request, setRequest] = useState(0);
  const [timing, setTiming] = useState<Awaited<
    ReturnType<typeof fetchTrajectoryTiming>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setTiming(null);
    setError(null);
    void fetchTrajectoryTiming(trajectoryId, {
      signal: controller.signal,
    }).then(
      (result) => {
        if (!controller.signal.aborted) setTiming(result);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => controller.abort();
  }, [request, trajectoryId]);

  return (
    <section aria-label="Server delivery timings" className="space-y-3">
      <button
        type="button"
        className="rounded-lg border border-border px-3 py-2 text-sm"
        disabled={request > 0 && timing === null && error === null}
        onClick={() => setRequest((previous) => previous + 1)}
      >
        {request ? "Reload server timings" : "Load server timings"}
      </button>
      <p className="text-sm text-muted-foreground">
        Optional local diagnostics from the latest 200 recorded inference turns.
        Matched by trajectory ID, not by time. Unavailable or missing records do
        not mean zero latency.
      </p>
      {request > 0 && !timing && !error && (
        <p role="status">Loading server timings…</p>
      )}
      {error && (
        <p role="status" className="text-sm">
          Server timings could not be loaded. This endpoint requires authorized
          local access. The trajectory below is still available. {error}
        </p>
      )}
      {timing?.turns.length === 0 && (
        <p className="text-sm">
          No exact timing match in the latest 200 turns. Older records or turns
          without correlation metadata cannot be joined here.
        </p>
      )}
      {timing?.turns.map((turn) => {
        const flow = timing.flows.find((item) => item.turnId === turn.turnId);
        return (
          <div key={turn.turnId} className="space-y-3">
            <h3 className="font-medium">Server delivery timings</h3>
            <p className="break-all font-mono text-xs">{turn.turnId}</p>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-sm tabular-nums">
              {(
                [
                  ["First reply committed by host", turn.timeToFirstVisibleMs],
                  ["Reply handed to delivery callback", turn.timeToReplyMs],
                  ["Host response finalized", turn.timeToResponseFinalizedMs],
                  ["Inference turn total", turn.totalMs],
                  ["First internal streamed token", turn.timeToFirstTokenMs],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="contents">
                  <dt>{label}</dt>
                  <dd>{value == null ? "Not recorded" : `${value} ms`}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-muted-foreground">
              Host delivery is not browser paint or audible speech. The first
              internal token can belong to planning, before any reply is ready.
              Inference and trajectory totals cover different recording windows.
            </p>
            {flow ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm tabular-nums">
                  <caption className="py-2 text-left">
                    Exclusive wall time: recorder-assigned overlapping spans are
                    counted once. Rounded to 0.1 ms; raw precision below.
                  </caption>
                  <thead>
                    <tr className="border-b border-border">
                      <th className="p-2">Stage</th>
                      <th className="p-2">Before host reply</th>
                      <th className="p-2">Whole turn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flow.stages.map((stage) => (
                      <tr key={stage.stage} className="border-b border-border">
                        <th className="p-2 font-normal">{stage.stage}</th>
                        <td className="p-2">
                          {stage.toFirstVisibleMs == null
                            ? "Not recorded"
                            : `${stage.toFirstVisibleMs.toFixed(1)} ms`}
                        </td>
                        <td className="p-2">{stage.totalMs.toFixed(1)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm">No exclusive breakdown was recorded.</p>
            )}
            {turn.anomalies.length > 0 && (
              <p className="text-sm">
                Recorder anomalies: {turn.anomalies.join("; ")}
              </p>
            )}
            <RecordedData
              label="Full timing record: spans, marks, metadata and breakdown"
              value={{ turn, flow: flow ?? null }}
            />
          </div>
        );
      })}
    </section>
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
      <InferenceTimingRecord key={trajectory.id} trajectoryId={trajectory.id} />
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
