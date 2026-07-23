/**
 * Web/DOM renderer for the `eliza.native-transcript/v1` contract — the browser
 * shell's implementation of the same render model the iOS/Android shells draw.
 * It consumes decoded {@link TranscriptEvent}s, folds them with the shared
 * reducer (`reduce.ts`), and paints one row per {@link TranscriptItem}.
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
        <div
          className="native-transcript-row"
          data-role="user"
          data-status={item.status}
        >
          <span dir="auto">{item.text}</span>
        </div>
      );
    case "agent":
      return (
        <div
          className="native-transcript-row"
          data-role="agent"
          data-status={item.status}
        >
          {renderAgentBody(item.text)}
        </div>
      );
    case "tool":
      return (
        <div
          className="native-transcript-row"
          data-role="tool"
          data-status={item.status}
        >
          <span>{item.name}</span>
          {item.detail ? <span dir="auto">{item.detail}</span> : null}
        </div>
      );
    case "error":
      return (
        <div
          className="native-transcript-row"
          role="alert"
          data-role="error"
          data-code={item.code}
          data-retryable={item.retryable}
        >
          <span dir="auto">{item.message ?? item.code}</span>
        </div>
      );
    case "reconnect":
      return (
        <div
          className="native-transcript-row"
          data-role="reconnect"
          data-phase={item.phase}
          data-attempt={item.attempt}
        />
      );
    default: {
      const _never: never = item;
      void _never;
      return null;
    }
  }
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
  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      data-testid="native-transcript"
      data-connection={view.connection}
      data-speaking={view.speaking ? view.speaking.utteranceId : undefined}
    >
      {view.items.map((item) => (
        <TranscriptRow key={item.id} item={item} />
      ))}
    </div>
  );
}
