/**
 * Realtime local transcript surface for the omi pendant.
 *
 * It owns a Phase 1 browser-local session: connect BLE, show pending/resolved/
 * dropped ASR segments, persist them across refresh, and pause ambient capture
 * without disconnecting the pendant or stopping battery updates.
 */

import {
  ArrowDown,
  BatteryLow,
  BatteryMedium,
  Bluetooth,
  BluetoothConnected,
  Loader2,
  Mic,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useThreadAutoScroll } from "../../hooks/useThreadAutoScroll";
import { cn } from "../../lib/utils";
import {
  loadPendantTranscriptSession,
  type PendantTranscriptSegment,
  pendantTranscriptSessionReducer,
  savePendantTranscriptSession,
} from "../../pendant/pendant-transcript-session";
import { usePendant } from "../../pendant/usePendant";
import { Button } from "../ui/button";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

const CLOCK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatClock(ms: number): string {
  return CLOCK_FORMATTER.format(ms);
}

function isLiveStatus(status: string): boolean {
  return (
    status === "connected" ||
    status === "listening" ||
    status === "hearing" ||
    status === "transcribing" ||
    status === "paused"
  );
}

function SegmentRow({
  segment,
}: {
  segment: PendantTranscriptSegment;
}): React.ReactElement {
  const pending = segment.status === "pending";
  const dropped = segment.status === "dropped";
  return (
    <article
      className={cn(
        "border-b border-border px-4 py-4",
        pending && "text-muted",
        dropped && "text-muted/70",
      )}
      data-testid={`pendant-segment-${segment.status}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-2xs uppercase text-muted">
        <span>{formatClock(segment.startedAt)}</span>
        <span>{Math.max(0, segment.durationMs / 1_000).toFixed(1)}s</span>
      </div>
      {pending ? (
        <p className="text-sm leading-6">Transcribing...</p>
      ) : dropped ? (
        <p className="text-sm leading-6">Dropped before transcript</p>
      ) : (
        <p className="text-base leading-7 text-txt">{segment.text}</p>
      )}
      {segment.words.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {segment.words.map((word) => (
            <span
              key={`${segment.id}-${word.startMs}-${word.endMs}-${word.text}`}
              className="rounded-xs bg-bg-muted px-1.5 py-1 text-2xs text-muted-strong"
              title={`${word.startMs}-${word.endMs}ms`}
            >
              {word.text}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function BatteryDisplay({
  percent,
}: {
  percent: number | null;
}): React.ReactElement {
  const Icon = percent !== null && percent <= 20 ? BatteryLow : BatteryMedium;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <Icon className="size-4" aria-hidden />
      {percent === null ? "Battery --" : `${percent}%`}
    </span>
  );
}

export function PendantTranscriptView(): React.ReactElement {
  const [session, dispatchSession] = React.useReducer(
    pendantTranscriptSessionReducer,
    undefined,
    () => loadPendantTranscriptSession(),
  );
  const { scrollRef, atBottom, jumpToLatest } =
    useThreadAutoScroll<HTMLDivElement>({
      growthKey: `${session.segments.length}:${
        session.segments.at(-1)?.status ?? "empty"
      }:${session.segments.at(-1)?.text.length ?? 0}`,
    });

  const { state, supported, connect, disconnect, pause, resume } = usePendant({
    onSegment: React.useCallback((detail) => {
      dispatchSession({ type: "segment", detail });
    }, []),
  });

  React.useEffect(() => {
    savePendantTranscriptSession(session);
  }, [session]);

  const live = isLiveStatus(state.status);
  const busy = state.status === "requesting" || state.status === "connecting";
  const pendingCount = session.segments.filter(
    (segment) => segment.status === "pending",
  ).length;
  const resolvedCount = session.segments.filter(
    (segment) => segment.status === "resolved",
  ).length;
  const errorMessage =
    state.status === "error"
      ? (state.error ?? "Pendant transcript connection failed.")
      : state.error;

  return (
    <ShellViewAgentSurface viewId="pendant-transcript">
      <div className="flex h-full min-h-0 w-full flex-col bg-bg text-txt">
        <header className="border-b border-border px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-txt-strong">
                Pendant Transcript
              </h1>
              <p className="mt-1 text-sm text-muted">
                {state.deviceName ?? "omi pendant"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1.5 text-xs",
                  live && !state.paused && "border-accent text-accent",
                  state.paused && "text-muted",
                )}
                data-testid="pendant-recording-indicator"
              >
                {live ? (
                  <Mic
                    className={cn(
                      "size-4",
                      !state.paused &&
                        "animate-pulse motion-reduce:animate-none",
                    )}
                    aria-hidden
                  />
                ) : (
                  <Bluetooth className="size-4" aria-hidden />
                )}
                {state.paused ? "Paused" : live ? "Recording" : "Idle"}
              </span>
              <BatteryDisplay percent={state.batteryPercent} />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {!supported ? (
              <span className="text-sm text-muted">
                Bluetooth pendant is not available in this environment.
              </span>
            ) : live ? (
              <>
                <Button
                  variant="surface"
                  size="sm"
                  onClick={disconnect}
                  data-testid="pendant-transcript-disconnect"
                >
                  <BluetoothConnected className="size-4" aria-hidden />
                  Disconnect
                </Button>
                {state.paused ? (
                  <Button
                    variant="surfaceAccent"
                    size="sm"
                    onClick={resume}
                    data-testid="pendant-transcript-resume"
                  >
                    <Play className="size-4" aria-hidden />
                    Resume
                  </Button>
                ) : (
                  <Button
                    variant="surface"
                    size="sm"
                    onClick={pause}
                    data-testid="pendant-transcript-pause"
                  >
                    <Pause className="size-4" aria-hidden />
                    Pause
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="surfaceAccent"
                size="sm"
                onClick={connect}
                disabled={busy}
                data-testid="pendant-transcript-connect"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Bluetooth className="size-4" aria-hidden />
                )}
                {busy ? "Connecting..." : "Connect"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dispatchSession({ type: "clear", at: Date.now() })}
              disabled={session.segments.length === 0}
              data-testid="pendant-transcript-clear"
            >
              <Trash2 className="size-4" aria-hidden />
              Clear
            </Button>
            <span className="text-xs text-muted">
              {resolvedCount} resolved · {pendingCount} pending
            </span>
          </div>
          {errorMessage ? (
            <div
              role="alert"
              className="mt-3 border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-danger"
              data-testid="pendant-transcript-error"
            >
              {errorMessage}
            </div>
          ) : null}
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="h-full overflow-y-auto"
            aria-live="polite"
            data-testid="pendant-transcript-feed"
          >
            {session.segments.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-md">
                  <p className="text-sm font-medium text-txt-strong">
                    No transcript segments yet
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Connect the pendant and speak. Pending segments appear as
                    soon as a VAD turn ends.
                  </p>
                </div>
              </div>
            ) : (
              session.segments.map((segment) => (
                <SegmentRow key={segment.id} segment={segment} />
              ))
            )}
          </div>
          {!atBottom ? (
            <Button
              variant="surfaceAccent"
              size="sm"
              onClick={jumpToLatest}
              className="absolute bottom-4 left-1/2 -translate-x-1/2"
              data-testid="pendant-transcript-jump"
            >
              <ArrowDown className="size-4" aria-hidden />
              Latest
            </Button>
          ) : null}
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
