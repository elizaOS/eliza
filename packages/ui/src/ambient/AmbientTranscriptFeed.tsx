/**
 * Live ambient transcript feed.
 *
 * Renders the streaming segment list from the REUSED pendant transcript store
 * (`PendantTranscriptSegment` — no new transcript store). Segments render in
 * their lifecycle states: `pending` (in-flight, muted "Transcribing…"),
 * `resolved` (final text), `failed` (quiet failure). Auto-scrolls to the latest
 * segment while pinned to the bottom, with a "Latest" jump affordance otherwise
 * — the same interaction the pendant transcript view uses, so the two surfaces
 * feel identical.
 *
 * LP3-first: single column, large readable body text, no bleeding-edge CSS.
 */

import { ArrowDown } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { useThreadAutoScroll } from "../hooks/useThreadAutoScroll";
import type { PendantTranscriptSegment } from "../pendant/pendant-transcript-session";

const CLOCK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatClock(ms: number): string {
  return CLOCK_FORMATTER.format(ms);
}

function AmbientSegmentRow({
  segment,
}: {
  segment: PendantTranscriptSegment;
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
      data-testid={`ambient-segment-${segment.status}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-2xs uppercase text-muted">
        <span>{formatClock(segment.startedAt)}</span>
        <span>{Math.max(0, segment.durationMs / 1_000).toFixed(1)}s</span>
      </div>
      {pending ? (
        <p className="text-sm leading-6">Transcribing…</p>
      ) : failed ? (
        <p className="text-sm leading-6">
          {segment.warning ?? "Could not transcribe this segment."}
        </p>
      ) : (
        <p className="text-base leading-7 text-txt">{segment.text}</p>
      )}
    </article>
  );
}

export interface AmbientTranscriptFeedProps {
  segments: PendantTranscriptSegment[];
  /** True while capture is live; drives the empty-state copy. */
  capturing: boolean;
  cacheError?: string | null;
  className?: string;
}

export function AmbientTranscriptFeed({
  segments,
  capturing,
  cacheError,
  className,
}: AmbientTranscriptFeedProps): React.ReactElement {
  const { scrollRef, atBottom, jumpToLatest } =
    useThreadAutoScroll<HTMLDivElement>({
      growthKey: `${segments.length}:${
        segments.at(-1)?.status ?? "empty"
      }:${segments.at(-1)?.text.length ?? 0}`,
    });

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto"
        aria-live="polite"
        data-testid="ambient-transcript-feed"
      >
        {cacheError && segments.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="max-w-md">
              <p className="text-sm font-medium text-danger">
                Transcript cache unavailable
              </p>
              <p className="mt-2 text-sm leading-6 text-muted">
                Clear the local view to retry storage access.
              </p>
            </div>
          </div>
        ) : segments.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="max-w-md">
              <p className="text-sm font-medium text-txt-strong">
                {capturing ? "Listening…" : "No transcript yet"}
              </p>
              <p className="mt-2 text-sm leading-6 text-muted">
                {capturing
                  ? "Speak, and finalized segments appear here as each turn ends."
                  : "Start listening, and finalized segments appear here as you speak."}
              </p>
            </div>
          </div>
        ) : (
          segments.map((segment) => (
            <AmbientSegmentRow key={segment.id} segment={segment} />
          ))
        )}
      </div>
      {!atBottom ? (
        <Button
          variant="surfaceAccent"
          size="sm"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2"
          data-testid="ambient-transcript-jump"
        >
          <ArrowDown className="size-4" aria-hidden />
          Latest
        </Button>
      ) : null}
    </div>
  );
}
