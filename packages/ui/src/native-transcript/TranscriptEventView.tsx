/**
 * Product renderer for the `eliza.native-transcript/v1` contract. It consumes
 * either decoded {@link TranscriptEvent}s or a validated projection returned
 * by the iOS, Android, or desktop host, then paints one row per
 * {@link TranscriptItem} in the shared React chat surface.
 *
 * Every visual decision reads a STRUCTURAL field — `item.kind`, `item.status`,
 * `speaking`, `connection` — never the transcript text or its length. Agent text
 * is split with the existing chat parser (`parseSegments`) so prose and code
 * render exactly as they do in the full chat surface; interactive widgets are a
 * full-chat concern and are intentionally not surfaced on this transcript rail.
 * `dir="auto"` lets the browser bidi-resolve each row so Unicode/RTL utterances
 * render correctly without any text inspection here.
 */

import { type ReactNode, useMemo } from "react";
import { parseSegments } from "../components/chat/message-parser-helpers";
import { Alert } from "../components/ui/alert";
import { Card } from "../components/ui/card";
import { CodeBlock } from "../components/ui/code-block";
import { cn } from "../lib/utils";
import type {
  TranscriptEvent,
  TranscriptItem,
  TranscriptViewModel,
} from "./contract";
import { reduceTranscriptEvents } from "./reduce";

/** Fold a decoded event log into the render model (memoized by identity). */
export function useTranscriptEvents(
  events: readonly TranscriptEvent[],
): TranscriptViewModel {
  return useMemo(() => reduceTranscriptEvents(events), [events]);
}

export interface TranscriptEventViewProps {
  /** The decoded, append-only event log to render. */
  events: readonly TranscriptEvent[];
  className?: string;
}

export interface TranscriptViewProps {
  /** A validated view model produced by the shared or native reducer. */
  viewModel: TranscriptViewModel;
  className?: string;
  label?: string;
}

/** Render agent prose + code via the shared chat parser; drop widget markers. */
function renderAgentBody(text: string): ReactNode {
  const segments = parseSegments(text, false);
  return segments.map((segment, index) => {
    const key = `${segment.kind}-${index}`;
    if (segment.kind === "text") {
      return (
        <span key={key} dir="auto">
          {segment.text}
        </span>
      );
    }
    if (segment.kind === "code") {
      return (
        <CodeBlock
          key={key}
          value={segment.code}
          variant={segment.inline ? "inline" : "block"}
          copyable={!segment.inline}
        />
      );
    }
    return null;
  });
}

function TranscriptRow({ item }: { item: TranscriptItem }): ReactNode {
  switch (item.kind) {
    case "user":
      return (
        <Card
          variant="nativeTranscriptUser"
          className={cn(
            "native-transcript-row ml-auto max-w-[85%] text-sm leading-relaxed text-txt",
            item.status === "partial" && "italic text-muted",
            item.status === "cancelled" && "opacity-60 line-through",
          )}
          data-role="user"
          data-status={item.status}
        >
          <span dir="auto">{item.text}</span>
        </Card>
      );
    case "agent":
      return (
        <div
          className={cn(
            "native-transcript-row mr-auto max-w-[85%] p-1 text-sm leading-relaxed text-txt",
            item.status === "streaming" && "text-muted",
            item.status === "cancelled" && "opacity-60 line-through",
          )}
          data-role="agent"
          data-status={item.status}
        >
          {renderAgentBody(item.text)}
        </div>
      );
    case "tool":
      return (
        <div
          className={cn(
            "native-transcript-row flex max-w-full items-center gap-1.5 px-1 py-0.5 text-xs text-muted",
            item.status === "failed" && "text-danger",
            item.status === "cancelled" && "opacity-60",
          )}
          role="status"
          data-role="tool"
          data-status={item.status}
        >
          <span className="font-medium text-txt">{item.name}</span>
          <span aria-hidden="true">·</span>
          <span>{item.status}</span>
          {item.detail ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate" dir="auto" title={item.detail}>
                {item.detail}
              </span>
            </>
          ) : null}
        </div>
      );
    case "error":
      return (
        <Alert
          variant="inlineDangerCompact"
          className="native-transcript-row"
          data-role="error"
          data-code={item.code}
          data-retryable={item.retryable}
        >
          <span dir="auto">{item.message ?? item.code}</span>
        </Alert>
      );
    case "reconnect":
      return (
        <div
          className={cn(
            "native-transcript-row px-1 py-0.5 text-xs",
            item.phase === "lost" ? "text-warn" : "text-ok",
          )}
          role="status"
          data-role="reconnect"
          data-phase={item.phase}
          data-attempt={item.attempt}
        >
          {item.phase === "lost"
            ? `Connection lost · reconnecting (attempt ${item.attempt})`
            : "Connection restored"}
        </div>
      );
    default: {
      const _never: never = item;
      void _never;
      return null;
    }
  }
}

/** Render a validated reducer projection without reinterpreting its payload. */
export function TranscriptView({
  viewModel,
  className,
  label = "Live voice transcript",
}: TranscriptViewProps): ReactNode {
  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      data-testid="native-transcript"
      data-connection={viewModel.connection}
      data-speaking={viewModel.speaking?.utteranceId}
      role="log"
      aria-label={label}
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions text"
    >
      {viewModel.items.map((item) => (
        <TranscriptRow key={`${item.kind}:${item.id}`} item={item} />
      ))}
      {viewModel.speaking ? (
        <div
          className="px-1 py-0.5 text-xs text-muted"
          role="status"
          data-role="speaking"
        >
          Eliza is speaking
        </div>
      ) : null}
    </div>
  );
}

/**
 * Render a transcript-event log. Ordering, dedupe, late-event, and cancellation
 * are decided by the reducer; this component only maps the resulting items to
 * DOM. The container exposes `data-connection` and `data-speaking` so shells and
 * tests can read transport state without re-deriving it.
 */
export function TranscriptEventView({
  events,
  className,
}: TranscriptEventViewProps): ReactNode {
  const view = useTranscriptEvents(events);
  return <TranscriptView viewModel={view} className={className} />;
}
