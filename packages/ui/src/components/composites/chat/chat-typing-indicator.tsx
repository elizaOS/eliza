/**
 * The one typing/working indicator for every chat surface (#12188 Phase 3).
 * `TypingIndicator` is the pending-reply bubble (panel `default` and
 * `game-modal` skins, used by ChatView and the homescreen ChatSurface);
 * `TurnStatus` is the phase-aware variant the continuous-chat overlay shows
 * while the agent works — a spinner glyph plus a debounced phase label and a
 * live elapsed-seconds clock ("Thinking · 4s", "Running WEB_SEARCH · 12s"), the
 * Codex-style working indicator (#13535). All three render paths share the
 * single `TypingDots` triad so there is exactly one dots implementation.
 *
 * Every TurnStatus phase uses the same neutral shimmer so transport state never
 * changes the chat's accent color or flashes between unrelated treatments.
 */
import { useEffect, useRef, useState } from "react";

import type { ChatTurnStatus } from "../../../api/client-types-chat";
import { Marker, MarkerContent, MarkerIcon } from "../../ui/marker";
import { Spinner } from "../../ui/spinner";
import { ChatBubble } from "./chat-bubble";
import type { ChatVariant } from "./chat-types";

/** The shared three-dot triad. Purely presentational; each consumer passes its
 * own dot skin + stagger so the three surface designs stay pixel-stable. */
function TypingDots({
  className,
  dotClassName,
  delaysMs,
  testId,
}: {
  className: string;
  dotClassName: string;
  delaysMs: readonly [number, number, number];
  testId?: string;
}) {
  return (
    <span className={className} data-testid={testId} aria-hidden="true">
      {delaysMs.map((delay) => (
        <span
          key={delay}
          className={dotClassName}
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

export interface TypingIndicatorProps {
  agentName: string;
  className?: string;
  variant?: ChatVariant;
}

export function TypingIndicator({
  agentName,
  className,
  variant = "default",
}: TypingIndicatorProps) {
  if (variant === "game-modal") {
    return (
      <div
        className={className ?? "flex w-full justify-start"}
        role="status"
        aria-live="polite"
        aria-label={`${agentName} is typing`}
      >
        <ChatBubble
          tone="assistant"
          className="flex max-w-[min(85%,24rem)] items-center gap-1 rounded-sm px-4 py-3"
        >
          <TypingDots
            className="flex items-center gap-1"
            dotClassName="h-1.5 w-1.5 rounded-full bg-[color:color-mix(in_srgb,var(--muted)_82%,transparent)] animate-bounce"
            delaysMs={[0, 150, 300]}
          />
        </ChatBubble>
      </div>
    );
  }

  return (
    <div className={className ?? "mt-1.5 flex min-w-0 flex-col"}>
      <div className="mb-0.5 text-xs font-semibold text-accent">
        {agentName}
      </div>
      <TypingDots
        className="flex gap-1 py-1"
        dotClassName="h-2 w-2 rounded-full bg-muted-strong animate-[typing-bounce_1.2s_ease-in-out_infinite]"
        delaysMs={[0, 200, 400]}
      />
    </div>
  );
}

/** Humanize an action/tool symbol ("SEND_MESSAGE" → "Send message") for the
 *  status label so it reads as prose, not a constant. */
function humanizeStatusName(name: string): string {
  const cleaned = name.trim().replace(/[_-]+/g, " ").toLowerCase();
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** The phase label shown beside the breathing dots. Server-provided `label`
 *  always wins; otherwise derive a concise phrase from the kind (+ action/tool
 *  name when present). */
export function turnStatusLabel(status: ChatTurnStatus): string {
  if (status.label?.trim()) return status.label.trim();
  switch (status.kind) {
    case "thinking":
      return "Thinking";
    case "streaming":
      return "Replying";
    case "running_action":
      if (status.actionName?.trim().toUpperCase() === "REPLY") {
        return "Replying";
      }
      return status.actionName
        ? `Running ${humanizeStatusName(status.actionName)}`
        : "Working";
    case "running_tool":
      return status.toolName
        ? `Using ${humanizeStatusName(status.toolName)}`
        : "Using a tool";
    case "evaluating":
      return "Reflecting";
    case "waking":
      return "Waking the agent";
    case "speaking":
      return "Speaking";
  }
}

// Min time (ms) a phase label must stay on screen before the next one replaces
// it. Without this, a fast thinking→action→streaming sequence flickers through
// labels faster than the eye can read. The text content the user sees is
// debounced; the dots animate continuously throughout.
const STATUS_MIN_DWELL_MS = 320;

/** Debounce a fast-changing status to a min on-screen dwell so a rapid
 *  thinking→action→streaming sequence doesn't strobe the label. The dots animate
 *  continuously; only the words wait their turn. Returns null when status is
 *  null (between turns). */
function useDebouncedTurnStatus(
  status: ChatTurnStatus | null,
): ChatTurnStatus | null {
  const [shown, setShown] = useState<ChatTurnStatus | null>(status);
  const lastChangeRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!status) {
      setShown(null);
      return;
    }
    const now = Date.now();
    const elapsed = now - lastChangeRef.current;
    if (elapsed >= STATUS_MIN_DWELL_MS) {
      lastChangeRef.current = now;
      setShown(status);
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      lastChangeRef.current = Date.now();
      setShown(status);
      timerRef.current = null;
    }, STATUS_MIN_DWELL_MS - elapsed);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status]);
  return shown;
}

// Grace before the elapsed clock appears: a fast turn settles in under a second,
// so only a turn that outlasts this shows a timer — no "0s" flash on quick
// replies. Once shown, the clock ticks each whole second.
const ELAPSED_VISIBLE_AFTER_MS = 900;

/** Whole-second elapsed clock for the working indicator, started the moment a
 *  status first appears (`active` goes true) and reset to 0 when it clears.
 *  Returns -1 until the grace window passes so the caller can hide the timer on
 *  a sub-second turn. The wall-clock read lives in the interval (effect
 *  context), never at render, so screenshots stay byte-stable. */
function useElapsedSeconds(active: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    startRef.current = start;
    setElapsedMs(0);
    const id = window.setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active || elapsedMs < ELAPSED_VISIBLE_AFTER_MS) return -1;
  return Math.floor(elapsedMs / 1000);
}

/** Compact elapsed label: "8s" under a minute, "2m 05s" beyond. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

/**
 * The Codex-style working indicator — a spinner glyph, the debounced phase label
 * (a word for every phase, including `thinking`), and a live elapsed-seconds
 * clock — WITHOUT a bubble/motion wrapper; the overlay wraps it in its own glass
 * chrome. When `showLabel` is false (the in-flight assistant bubble) it degrades
 * to the bare breathing dots so the streamed text fills in where the dots were.
 *
 * Mirrors ChatVoiceStatusBar's a11y (`role="status"` + `aria-live="polite"`).
 * Honors reduced motion (no spin/pulse). Degrades to plain dots when no status
 * has arrived.
 */
export function TurnStatus({
  status,
  showLabel = true,
}: {
  status: ChatTurnStatus | null;
  showLabel?: boolean;
}) {
  const shown = useDebouncedTurnStatus(status);
  // Clock is driven by the raw (un-debounced) status so it starts at turn open,
  // not after the label's min-dwell debounce.
  const elapsed = useElapsedSeconds(status !== null);
  const label = shown ? turnStatusLabel(shown) : "Thinking";

  if (!showLabel) {
    // In-bubble variant: a compact shadcn Marker sits exactly where streamed
    // text will replace it. Shimmer communicates active generation without a
    // second animated glyph or bubble.
    return (
      <Marker
        className="w-fit text-white/80"
        data-testid="turn-status-indicator"
        data-status-kind={shown?.kind ?? "none"}
        role="status"
        aria-live="polite"
      >
        <MarkerContent
          className="shimmer text-[13px] font-medium motion-reduce:shimmer-none"
          data-testid="turn-status-label"
        >
          {label}
        </MarkerContent>
      </Marker>
    );
  }

  return (
    <Marker
      className="w-fit text-white/90"
      data-testid="turn-status-indicator"
      data-status-kind={shown?.kind ?? "none"}
      role="status"
      aria-live="polite"
    >
      <MarkerIcon>
        <Spinner
          size={14}
          data-testid="turn-status-spinner"
          className="text-white/70 motion-reduce:animate-none"
        />
      </MarkerIcon>
      <MarkerContent className="inline-flex items-baseline text-[13px] font-medium tabular-nums">
        <span
          className="shimmer motion-reduce:shimmer-none"
          data-testid="turn-status-label"
        >
          {label}
        </span>
        {elapsed >= 0 ? (
          <span className="ml-1.5 opacity-60" data-testid="turn-status-elapsed">
            · {formatElapsed(elapsed)}
          </span>
        ) : null}
      </MarkerContent>
    </Marker>
  );
}
