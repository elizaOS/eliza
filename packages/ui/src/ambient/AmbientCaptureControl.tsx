/**
 * Ambient capture control surface.
 *
 * The command header for an ambient session: consent gate before first start,
 * start/pause/resume/stop lifecycle, the always-visible recording indicator,
 * and session bookkeeping (duration mm:ss + resolved/pending segment counts).
 *
 * Layout is LP3-first: single column, big tap targets (`size="lg"`, full-width
 * buttons), monochrome-safe state via the indicator, and no bleeding-edge CSS
 * (flex + border tokens only). Black/white/orange tokens + lucide icons; no
 * gradients, no emoji.
 */

import { Ear, Loader2, Pause, Play, Square } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { AmbientConsentGate } from "./AmbientConsentGate";
import { AmbientRecordingIndicator } from "./AmbientRecordingIndicator";
import { ambientCaptureAllowed, type AmbientConsentState } from "./ambient-consent";
import type { AmbientSessionSnapshot } from "./ambient-session-adapter";

export interface AmbientCaptureControlProps {
  snapshot: AmbientSessionSnapshot;
  consent: AmbientConsentState;
  elapsedMs: number;
  resolvedCount: number;
  pendingCount: number;
  onGrantConsent: () => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  className?: string;
}

/** Format elapsed ms as mm:ss (or h:mm:ss past an hour). Grayscale-friendly. */
export function formatAmbientDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function AmbientCaptureControl({
  snapshot,
  consent,
  elapsedMs,
  resolvedCount,
  pendingCount,
  onGrantConsent,
  onStart,
  onPause,
  onResume,
  onStop,
  className,
}: AmbientCaptureControlProps): React.ReactElement {
  const { status, supported } = snapshot;
  const capturing = status === "capturing";
  const paused = status === "paused";
  const active = capturing || paused;
  const starting = status === "starting";
  const canStart = ambientCaptureAllowed(consent);

  return (
    <section
      data-testid="ambient-capture-control"
      className={cn("flex flex-col gap-4", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AmbientRecordingIndicator
          status={status}
          processingLocation={snapshot.processingLocation}
        />
        {active ? (
          <div
            className="flex items-center gap-4 font-mono text-sm text-muted"
            data-testid="ambient-session-stats"
          >
            <span data-testid="ambient-duration">
              {formatAmbientDuration(elapsedMs)}
            </span>
            <span data-testid="ambient-segment-count">
              {resolvedCount} · {pendingCount} pending
            </span>
          </div>
        ) : null}
      </div>

      {!supported ? (
        <div
          className="border-l-2 border-border bg-bg-muted px-3 py-2.5 text-sm text-muted"
          data-testid="ambient-unsupported"
        >
          Ambient listening isn't available in this environment. Use the Android
          app or a desktop Chrome browser. On iPhone, ambient runs only while the
          app is open and in the foreground.
        </div>
      ) : !active && !canStart ? (
        <AmbientConsentGate
          processingLocation={snapshot.processingLocation}
          onGrant={onGrantConsent}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {!active ? (
            <Button
              variant="surfaceAccent"
              size="lg"
              onClick={onStart}
              disabled={starting}
              data-testid="ambient-start"
              className="w-full"
            >
              {starting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Ear className="size-4" aria-hidden />
              )}
              {starting ? "Starting…" : "Start listening"}
            </Button>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              {paused ? (
                <Button
                  variant="surfaceAccent"
                  size="lg"
                  onClick={onResume}
                  data-testid="ambient-resume"
                  className="w-full"
                >
                  <Play className="size-4" aria-hidden />
                  Resume
                </Button>
              ) : (
                <Button
                  variant="surface"
                  size="lg"
                  onClick={onPause}
                  data-testid="ambient-pause"
                  className="w-full"
                >
                  <Pause className="size-4" aria-hidden />
                  Pause
                </Button>
              )}
              <Button
                variant="surfaceDestructive"
                size="lg"
                onClick={onStop}
                data-testid="ambient-stop"
                className="w-full"
              >
                <Square className="size-4" aria-hidden />
                Stop
              </Button>
            </div>
          )}
        </div>
      )}

      {snapshot.error ? (
        <div
          role="alert"
          className="border-l-2 border-danger bg-danger/10 px-3 py-2.5 text-sm text-danger"
          data-testid="ambient-control-error"
        >
          {snapshot.error}
        </div>
      ) : null}
    </section>
  );
}
