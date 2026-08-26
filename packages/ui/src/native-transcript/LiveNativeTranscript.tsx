/**
 * Product-facing live captions for the real chat/voice composer. The snapshot
 * comes from the web reducer immediately and is replaced by the validated
 * iOS, Android, or Electrobun reducer result after that host round-trip.
 */

import { ChevronDown } from "lucide-react";
import {
  type ReactNode,
  type SyntheticEvent,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { cn } from "../lib/utils";
import type { TranscriptItem, TranscriptViewModel } from "./contract";
import {
  getNativeTranscriptSnapshot,
  type NativeTranscriptSnapshot,
  subscribeNativeTranscript,
} from "./live-store";
import { TranscriptView } from "./TranscriptEventView";

export interface LiveNativeTranscriptProps {
  className?: string;
}

export interface LiveNativeTranscriptViewProps
  extends LiveNativeTranscriptProps {
  snapshot: NativeTranscriptSnapshot;
}

/** Subscribe the product UI to the cross-platform reducer projection. */
export function useLiveNativeTranscript(): NativeTranscriptSnapshot {
  return useSyncExternalStore(
    subscribeNativeTranscript,
    getNativeTranscriptSnapshot,
    getNativeTranscriptSnapshot,
  );
}

function latestActiveItem(view: TranscriptViewModel): TranscriptItem | null {
  for (let index = view.items.length - 1; index >= 0; index -= 1) {
    const item = view.items[index];
    if (
      (item.kind === "user" && item.status === "partial") ||
      (item.kind === "agent" && item.status === "streaming") ||
      (item.kind === "tool" && item.status === "running")
    ) {
      return item;
    }
  }
  return view.items.at(-1) ?? null;
}

function activitySummary(view: TranscriptViewModel): ReactNode {
  if (view.connection === "lost") return "Reconnecting…";
  if (view.speaking) return "Eliza is speaking";
  const item = latestActiveItem(view);
  if (!item) return null;
  switch (item.kind) {
    case "user":
    case "agent":
      return <span dir="auto">{item.text}</span>;
    case "tool":
      return `${item.name} · ${item.status}`;
    case "error":
      return item.message ?? item.code;
    case "reconnect":
      return item.phase === "lost" ? "Reconnecting…" : "Connection restored";
    default: {
      const _never: never = item;
      void _never;
      return null;
    }
  }
}

export function hasLiveNativeTranscriptContent(
  view: TranscriptViewModel,
): boolean {
  return !(
    view.items.length === 0 &&
    view.speaking === null &&
    view.connection === "live"
  );
}

/**
 * Inline live-caption disclosure mounted in ChatVoiceStatusBar. Its summary
 * keeps the current structural activity visible without duplicating the whole
 * settled chat; expanding reveals the complete typed stream for this app run.
 */
export function LiveNativeTranscriptView({
  snapshot,
  className,
}: LiveNativeTranscriptViewProps): ReactNode {
  const { view } = snapshot;
  const [expanded, setExpanded] = useState(false);
  if (!hasLiveNativeTranscriptContent(view)) return null;

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    setExpanded(event.currentTarget.open);
  };

  return (
    <Card
      asChild
      variant="topDivider"
      className={cn("group w-full basis-full pt-1 text-left", className)}
    >
      <details
        data-testid="native-transcript-activity"
        data-transcript-source={snapshot.source}
        onToggle={handleToggle}
      >
        <Button
          asChild
          variant="ghostMuted"
          size="content"
          nativeTranscriptSummary
        >
          <summary>
            <span className="shrink-0 font-medium text-txt">Live captions</span>
            <span
              className="min-w-0 flex-1 truncate"
              data-testid="native-transcript-activity-summary"
            >
              {activitySummary(view)}
            </span>
            <ChevronDown
              className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
        </Button>
        {expanded ? (
          <div
            className="max-h-48 overflow-y-auto px-1 pb-2 pt-1"
            data-scroll-cert-scroller
          >
            <TranscriptView viewModel={view} />
          </div>
        ) : null}
      </details>
    </Card>
  );
}

export function LiveNativeTranscript({
  className,
}: LiveNativeTranscriptProps): ReactNode {
  const snapshot = useLiveNativeTranscript();
  return <LiveNativeTranscriptView snapshot={snapshot} className={className} />;
}
