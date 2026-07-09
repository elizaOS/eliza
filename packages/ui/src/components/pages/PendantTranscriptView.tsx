/**
 * Realtime local transcript surface for the omi pendant.
 *
 * It owns a Phase 1 browser-local optimistic cache: connect BLE, show pending,
 * resolved, and failed ASR segments, persist them across refresh, and pause
 * ambient capture without disconnecting the pendant or stopping battery updates.
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
  Timer,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useThreadAutoScroll } from "../../hooks/useThreadAutoScroll";
import { cn } from "../../lib/utils";
import {
  isPendantLiveStatus,
  pendantStatusLabel,
} from "../../pendant/pendant-status";
import {
  createLocalOptimisticPendantTranscriptSessionAdapter,
  type PendantTranscriptSegment,
  pendantTranscriptSessionReducer,
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

function SegmentRow({
  segment,
  showTimings,
}: {
  segment: PendantTranscriptSegment;
  showTimings: boolean;
}): React.ReactElement {
  const pending = segment.status === "pending";
  const failed = segment.status === "failed";
  return (
    <article
      className={cn(
        "border-b border-border px-4 py-4",
        pending && "text-muted",
        failed && "text-muted/80",
      )}
      data-testid={`pendant-segment-${segment.status}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-2xs uppercase text-muted">
        <span>{formatClock(segment.startedAt)}</span>
        <span>{Math.max(0, segment.durationMs / 1_000).toFixed(1)}s</span>
      </div>
      {pending ? (
        <p className="text-sm leading-6">Transcribing...</p>
      ) : failed ? (
        <p className="text-sm leading-6">
          {segment.warning ?? "Could not transcribe this segment."}
        </p>
      ) : (
        <p className="text-base leading-7 text-txt">{segment.text}</p>
      )}
      {showTimings && segment.words.length > 0 ? (
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
  const sessionAdapter = React.useMemo(
    () => createLocalOptimisticPendantTranscriptSessionAdapter(),
    [],
  );
  const initialCache = React.useMemo(() => {
    try {
      return { session: sessionAdapter.load(), error: null as string | null };
    } catch (error) {
      // error-policy:J4 A blocked or corrupt cache renders an explicit unavailable state.
      return {
        session: {
          segments: [],
          updatedAt: null,
          clearedThrough: null,
        },
        error:
          error instanceof Error
            ? error.message
            : "Pendant transcript cache is unavailable.",
      };
    }
  }, [sessionAdapter]);
  const [session, dispatchSession] = React.useReducer(
    pendantTranscriptSessionReducer,
    initialCache.session,
  );
  const [cacheError, setCacheError] = React.useState(initialCache.error);
  const [showTimings, setShowTimings] = React.useState(false);
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
    if (cacheError) return;
    try {
      sessionAdapter.save(session);
    } catch (error) {
      // error-policy:J4 Persistence failures stay visible instead of reading as saved.
      setCacheError(
        error instanceof Error
          ? error.message
          : "Pendant transcript cache could not be saved.",
      );
    }
  }, [cacheError, session, sessionAdapter]);

  const live = isPendantLiveStatus(state.status);
  const frozen = !live && session.segments.length > 0;
  const busy =
    state.status === "requesting" ||
    state.status === "connecting" ||
    state.status === "reconnecting";
  const hasTimings = session.segments.some(
    (segment) => segment.words.length > 0,
  );
  const pendingCount = session.segments.filter(
    (segment) => segment.status === "pending",
  ).length;
  const resolvedCount = session.segments.filter(
    (segment) => segment.status === "resolved",
  ).length;
  const errorMessage =
    state.status === "error"
      ? (state.typedError?.message ??
        state.error ??
        "Pendant transcript connection failed.")
      : (state.typedError?.message ?? state.error);

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
                {state.paused
                  ? "Paused"
                  : state.status === "reconnecting"
                    ? "Reconnecting"
                    : live
                      ? "Recording"
                      : "Idle"}
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
                {busy ? pendantStatusLabel(state.status) : "Connect"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const at = Date.now();
                try {
                  sessionAdapter.clear(at);
                  dispatchSession({ type: "clear", at });
                  setCacheError(null);
                } catch (error) {
                  // error-policy:J4 Clear failures preserve the visible cache/error state.
                  setCacheError(
                    error instanceof Error
                      ? error.message
                      : "Pendant transcript cache could not be cleared.",
                  );
                }
              }}
              disabled={session.segments.length === 0 && !cacheError}
              data-testid="pendant-transcript-clear"
            >
              <Trash2 className="size-4" aria-hidden />
              Clear local view/cache
            </Button>
            {hasTimings ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowTimings((visible) => !visible)}
                data-testid="pendant-transcript-toggle-timings"
              >
                <Timer className="size-4" aria-hidden />
                {showTimings ? "Hide timings" : "Show timings"}
              </Button>
            ) : null}
            <span className="text-xs text-muted">
              {resolvedCount} resolved · {pendingCount} pending
            </span>
            <span className="text-xs text-muted">
              Local offline cache · this device only
            </span>
          </div>
          {frozen ? (
            <div
              className="mt-3 border-l-2 border-border bg-bg-muted px-3 py-2 text-sm text-muted"
              data-testid="pendant-transcript-frozen"
            >
              Feed frozen - reconnect the pendant to resume live capture.
            </div>
          ) : null}
          {errorMessage ? (
            <div
              role="alert"
              className="mt-3 border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-danger"
              data-testid="pendant-transcript-error"
            >
              {errorMessage}
            </div>
          ) : null}
          {cacheError ? (
            <div
              role="alert"
              className="mt-3 border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-danger"
              data-testid="pendant-transcript-cache-error"
            >
              {cacheError}
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
            {cacheError && session.segments.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-md">
                  <p className="text-sm font-medium text-danger">
                    Transcript cache unavailable
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Reset the local cache to retry storage access.
                  </p>
                </div>
              </div>
            ) : session.segments.length === 0 ? (
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
                <SegmentRow
                  key={segment.id}
                  segment={segment}
                  showTimings={showTimings}
                />
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
