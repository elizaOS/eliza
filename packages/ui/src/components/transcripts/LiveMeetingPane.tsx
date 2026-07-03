/**
 * LiveMeetingPane (#11856) — the in-progress meeting transcript surface of the
 * Transcripts view. While a meeting transcript is `status: "recording"` it
 * renders the confirmed segments plus the muted pending ASR tail, fed by
 * `meeting-transcript` events on the existing agent WebSocket, with a 5s
 * polling fallback against `GET /api/transcripts/:id` when the socket is not
 * delivering. Auto-scroll stays pinned to the bottom until the user scrolls up.
 */

import type {
  Transcript,
  TranscriptSegment,
} from "@elizaos/shared/transcripts";
import * as React from "react";
import { client } from "../../api/client";
import { parseMeetingTranscriptEvent } from "../../api/client-meetings";
import { cn } from "../../lib/utils";
import {
  applyMeetingTranscriptEvent,
  applyPolledTranscript,
  type LiveTranscriptState,
} from "./meeting-live";

const POLL_INTERVAL_MS = 5_000;
/** A ws event within this window means the socket is live — skip polling. */
const WS_FRESHNESS_MS = 12_000;
/** How close to the bottom (px) still counts as "pinned". */
const PIN_THRESHOLD_PX = 48;

export interface LiveMeetingPaneProps {
  /** The recording transcript record (seed segments + identity). */
  transcript: Transcript;
  className?: string;
}

function SegmentBlock({
  segment,
  muted,
  testId,
}: {
  segment: TranscriptSegment;
  muted: boolean;
  testId: string;
}): React.JSX.Element {
  return (
    <div data-testid={testId} className={cn(muted && "text-muted/70")}>
      {segment.speakerLabel ? (
        <div className="mb-0.5 text-xs font-medium text-muted">
          {segment.speakerLabel}
        </div>
      ) : null}
      <p className="leading-relaxed">{segment.text}</p>
    </div>
  );
}

export function LiveMeetingPane({
  transcript,
  className,
}: LiveMeetingPaneProps): React.JSX.Element {
  const [live, setLive] = React.useState<LiveTranscriptState>(() => ({
    confirmed: transcript.segments,
    pending: [],
  }));
  const lastWsEventAtRef = React.useRef(0);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const pinnedRef = React.useRef(true);
  const transcriptId = transcript.id;

  // Live events over the agent WebSocket.
  React.useEffect(() => {
    return client.onWsEvent("meeting-transcript", (data) => {
      const event = parseMeetingTranscriptEvent(data);
      if (!event || event.transcriptId !== transcriptId) return;
      lastWsEventAtRef.current = Date.now();
      setLive((prev) => applyMeetingTranscriptEvent(prev, event));
    });
  }, [transcriptId]);

  // Polling fallback — the record grows server-side while recording, so when
  // the socket has gone quiet re-fetch and reconcile.
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - lastWsEventAtRef.current < WS_FRESHNESS_MS) return;
      client
        .getTranscript(transcriptId)
        .then((r) =>
          setLive((prev) => applyPolledTranscript(prev, r.transcript)),
        )
        .catch(() => {
          // Transient poll failure — the next tick retries.
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [transcriptId]);

  const segmentCount = live.confirmed.length + live.pending.length;

  // Pin-to-bottom autoscroll: follow new segments unless the user scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on content growth.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [segmentCount]);

  const onScroll = React.useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    pinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX;
  }, []);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="live-meeting-pane"
      className={cn(
        "min-h-0 flex-1 space-y-4 overflow-y-auto text-txt",
        className,
      )}
      aria-live="polite"
    >
      {segmentCount === 0 ? (
        <p className="text-sm text-muted">Listening…</p>
      ) : null}
      {live.confirmed.map((seg, i) => (
        <SegmentBlock
          key={seg.id}
          segment={seg}
          muted={false}
          testId={`live-confirmed-${i}`}
        />
      ))}
      {live.pending.map((seg, i) => (
        <SegmentBlock
          key={`pending-${seg.id}`}
          segment={seg}
          muted
          testId={`live-pending-${i}`}
        />
      ))}
    </div>
  );
}
