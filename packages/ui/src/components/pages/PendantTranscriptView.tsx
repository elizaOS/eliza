/**
 * Canonical ambient transcript surface for the omi pendant.
 *
 * It presents the server-authoritative pendant session established by the
 * canonical session controller while keeping BLE capture default-off until the
 * user connects the pendant from this route.
 */

import type { PendantSessionSnapshot } from "@elizaos/shared/contracts";
import {
  ArrowDown,
  BatteryLow,
  BatteryMedium,
  Bluetooth,
  BluetoothConnected,
  CircleDot,
  Loader2,
  Pause,
  Play,
  Radio,
  Square,
  Timer,
} from "lucide-react";
import * as React from "react";
import { useThreadAutoScroll } from "../../hooks/useThreadAutoScroll";
import { cn } from "../../lib/utils";
import { CanonicalPendantSessionController } from "../../pendant/canonical-session-controller";
import {
  isPendantLiveStatus,
  pendantStatusLabel,
} from "../../pendant/pendant-status";
import type {
  PendantTranscriptSegment,
  PendantTranscriptSessionState,
} from "../../pendant/pendant-transcript-session";
import { createPendantSessionSyncClient } from "../../pendant/session-sync-client";
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

function PendantRecordingIndicator({
  live,
  paused,
  status,
  processingLocation,
}: {
  live: boolean;
  paused: boolean;
  status: string;
  processingLocation: string | null;
}): React.ReactElement {
  const listening = live && !paused;
  const label = paused
    ? "Paused"
    : status === "reconnecting"
      ? "Reconnecting"
      : listening
        ? "Listening"
        : "Off";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-2 rounded-sm border px-3 py-2 text-sm font-medium",
        listening
          ? "border-accent bg-accent-subtle text-txt-strong"
          : paused
            ? "border-border bg-card text-muted-strong"
            : "border-border bg-card text-muted",
      )}
      data-testid="pendant-recording-indicator"
      data-listening={listening ? "true" : "false"}
    >
      {listening ? (
        <Square
          className="size-3.5 fill-accent text-accent animate-pulse motion-reduce:animate-none"
          aria-hidden
        />
      ) : paused ? (
        <Radio className="size-3.5 text-muted-strong" aria-hidden />
      ) : (
        <CircleDot className="size-3.5 text-muted" aria-hidden />
      )}
      <span>{label}</span>
      {live && processingLocation ? (
        <span className="border-l border-border pl-2 text-2xs uppercase tracking-wide text-muted">
          {processingLocation}
        </span>
      ) : null}
    </div>
  );
}

export function PendantTranscriptView(): React.ReactElement {
  const [session, setSession] = React.useState<PendantTranscriptSessionState>({
    segments: [],
    updatedAt: null,
    clearedThrough: null,
  });
  const [syncError, setSyncError] = React.useState<string | null>(null);
  const [showTimings, setShowTimings] = React.useState(false);
  const [processingLocation, setProcessingLocation] = React.useState<
    PendantSessionSnapshot["session"]["processingLocation"] | null
  >(null);
  const controllerRef = React.useRef<CanonicalPendantSessionController | null>(
    null,
  );
  const acceptSnapshot = React.useCallback(
    (snapshot: PendantSessionSnapshot) => {
      const segments = snapshot.segments.map((segment) => ({
        id: segment.id,
        status:
          segment.status === "asr-error" ? ("failed" as const) : segment.status,
        text: segment.text,
        startedAt: Date.parse(segment.startedAt),
        endedAt: Date.parse(segment.endedAt ?? segment.updatedAt),
        durationMs: Math.max(
          0,
          Date.parse(segment.endedAt ?? segment.updatedAt) -
            Date.parse(segment.startedAt),
        ),
        words: segment.words.map((word) => ({
          text: word.word,
          startMs: word.startMs,
          endMs: word.endMs,
        })),
        warning: segment.error,
      }));
      setSession({
        segments,
        updatedAt:
          segments.at(-1)?.endedAt ?? Date.parse(snapshot.session.startedAt),
        clearedThrough: null,
      });
      setProcessingLocation(snapshot.session.processingLocation);
      setSyncError(null);
    },
    [],
  );
  const controller = React.useMemo(() => {
    const client = createPendantSessionSyncClient({
      onSnapshot: (snapshot) => {
        if (controllerRef.current?.acceptsSnapshot(snapshot)) {
          acceptSnapshot(snapshot);
        }
      },
      onError: (error) => setSyncError(error.message),
    });
    const nextController = new CanonicalPendantSessionController({
      client,
      holder: crypto.randomUUID(),
      onSnapshot: acceptSnapshot,
      onError: (error) => setSyncError(error.message),
    });
    controllerRef.current = nextController;
    return nextController;
  }, [acceptSnapshot]);
  const { scrollRef, atBottom, jumpToLatest } =
    useThreadAutoScroll<HTMLDivElement>({
      growthKey: `${session.segments.length}:${
        session.segments.at(-1)?.status ?? "empty"
      }:${session.segments.at(-1)?.text.length ?? 0}`,
    });

  const { state, supported, connect, disconnect, pause, resume } = usePendant({
    dispatchResolvedTranscript: false,
    onSegment: React.useCallback(
      (detail) => controller.handleSegment(detail),
      [controller],
    ),
  });

  React.useEffect(() => {
    void controller.followLatest().catch((error) => {
      setSyncError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      // error-policy:J5 stop reports the same failure through the controller onError boundary.
      void controller.stop().catch(() => undefined);
    };
  }, [controller]);

  const connectCanonical = React.useCallback(async () => {
    setSyncError(null);
    const connected = await connect();
    if (!connected) return;
    try {
      await controller.start();
    } catch (error) {
      const stop = controller.stop();
      await disconnect();
      // error-policy:J5 controller onError already records the teardown failure.
      await stop.catch(() => undefined);
      setSyncError(error instanceof Error ? error.message : String(error));
    }
  }, [connect, controller, disconnect]);
  const pauseCanonical = React.useCallback(async () => {
    pause();
    try {
      await controller.pause();
    } catch (error) {
      try {
        await controller.resume();
        resume();
      } catch (recoveryError) {
        setSyncError(
          recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError),
        );
        return;
      }
      setSyncError(error instanceof Error ? error.message : String(error));
    }
  }, [controller, pause, resume]);
  const resumeCanonical = React.useCallback(async () => {
    try {
      await controller.resume();
      resume();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
    }
  }, [controller, resume]);
  const disconnectCanonical = React.useCallback(async () => {
    const stop = controller.stop();
    await disconnect();
    try {
      await stop;
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
    }
  }, [controller, disconnect]);

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
              <PendantRecordingIndicator
                live={live}
                paused={state.paused}
                status={state.status}
                processingLocation={processingLocation}
              />
              <BatteryDisplay percent={state.batteryPercent} />
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            {!supported ? (
              <span className="text-sm text-muted">
                Bluetooth pendant is not available in this environment.
              </span>
            ) : live ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {state.paused ? (
                  <Button
                    variant="surfaceAccent"
                    size="lg"
                    onClick={resumeCanonical}
                    data-testid="pendant-transcript-resume"
                    className="w-full"
                  >
                    <Play className="size-4" aria-hidden />
                    Resume Listening
                  </Button>
                ) : (
                  <Button
                    variant="surface"
                    size="lg"
                    onClick={pauseCanonical}
                    data-testid="pendant-transcript-pause"
                    className="w-full"
                  >
                    <Pause className="size-4" aria-hidden />
                    Pause Listening
                  </Button>
                )}
                <Button
                  variant="surface"
                  size="lg"
                  onClick={disconnectCanonical}
                  data-testid="pendant-transcript-disconnect"
                  className="w-full"
                >
                  <BluetoothConnected className="size-4" aria-hidden />
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button
                variant="surfaceAccent"
                size="lg"
                onClick={connectCanonical}
                disabled={busy}
                data-testid="pendant-transcript-connect"
                className="w-full sm:w-auto"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Bluetooth className="size-4" aria-hidden />
                )}
                {busy ? pendantStatusLabel(state.status) : "Connect"}
              </Button>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>
                {resolvedCount} resolved · {pendingCount} pending
              </span>
              <span>
                Canonical private session · synced across owner devices
              </span>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
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
          {syncError ? (
            <div
              role="alert"
              className="mt-3 border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-danger"
              data-testid="pendant-transcript-sync-error"
            >
              {syncError}
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
            {syncError && session.segments.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-md">
                  <p className="text-sm font-medium text-danger">
                    Canonical transcript unavailable
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Reconnect to the private agent session to retry sync.
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
