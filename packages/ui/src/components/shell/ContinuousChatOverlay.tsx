import * as React from "react";

import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import type { ShellMessage } from "./shell-state";
import type { ShellController } from "./useShellController";

/**
 * The continuous-chat overlay: one always-present, ambient glass conversation
 * that floats over EVERY view. There are no separate chats and no switcher — it
 * is a single endless thread (the app's one active conversation, via
 * useShellController). Collapsed, recent lines "whisper" — dissolving in over
 * whatever is behind — and an always-present composer bar invites the next line;
 * expanding reveals the whole thread as one flowing, single-column transcript
 * (no chat-app bubbles). The container is pointer-events-none (the view behind
 * stays live); only the composer + thread capture input, so it is non-blocking,
 * unlike the focus-trapping AssistantOverlay it supersedes in the main shell.
 *
 * Two design rules keep it intimate rather than app-like:
 *  1. SELF-CONTAINED CONTRAST — every surface carries its own dark-glass scrim
 *     (or, for floating text, a soft shadow) plus fixed light text, never the
 *     theme's `--txt`, so it stays legible over any substrate: a bright view, a
 *     dark view, or the warm "good evening" backdrop.
 *  2. NO CHROME/SIGNAGE — the thread speaks for itself: no message counter, no
 *     "new chat", no tab strip, controls dissolve into the glass, and status is
 *     a soft breath of light, not a brand-colored alert ring.
 *
 * Pure/presentational: it takes the controller as a prop so it can be rendered
 * in isolation (stories / harness) with a mock. The app wraps it in a small
 * context-reading mount (see App.tsx) that supplies the shared controller.
 */

// Self-contained glass surfaces (fixed dark scrim + light edge highlight) — do
// NOT use theme `--txt`, so they read over bright, dark, or warm backdrops.
const GLASS_SHEET =
  "rounded-3xl border border-white/12 bg-black/55 backdrop-blur-2xl " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_26px_72px_-18px_rgba(0,0,0,0.72)]";

const GLASS_BAR =
  "flex items-center gap-2 rounded-full border border-white/18 bg-black/45 px-3 py-2 backdrop-blur-xl " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_16px_46px_-12px_rgba(0,0,0,0.66)]";

// Floating (un-scrimmed) text gets a soft shadow so it reads over bright views.
const FLOAT_SHADOW = "[text-shadow:0_1px_4px_rgba(0,0,0,0.7)]";

// Glyphs (viewBox 0 0 36 36), rendered in currentColor inside a soft chip — the
// up-arrow (send) and five-bar waveform (mic) from the shared composer language.
const SEND_GLYPH = "M18 10L25 18H21V27H15V18H11Z";
const MIC_GLYPH =
  "M6 14H9V22H6Z M11.5 10H14.5V26H11.5Z M16.5 7H19.5V29H16.5Z M22 10H25V26H22Z M27 14H30V22H27Z";

function Glyph({ d }: { d: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 36 36" className="h-4 w-4" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d={d} />
    </svg>
  );
}

/** A soft round glass control that dissolves into the bar; brightens only when active. */
function SoftButton({
  glyph,
  label,
  onClick,
  disabled,
  active,
}: {
  glyph: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      // aria-disabled (not the native attr) so the button stays focusable and its
      // label/reason is announceable; the click is guarded instead.
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        active
          ? "border-white/40 bg-white/85 text-black"
          : "border-white/15 bg-white/10 text-white/75 hover:bg-white/20 hover:text-white",
        disabled && "opacity-40",
      )}
    >
      <Glyph d={glyph} />
    </button>
  );
}

/** Three quiet, borderless dots that breathe while the assistant is replying. */
function TypingDots(): React.JSX.Element {
  return (
    <div
      className="flex gap-1.5"
      role="status"
      aria-label="assistant is responding"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 w-1.5 animate-pulse rounded-full bg-white/70",
            FLOAT_SHADOW,
          )}
          style={{ animationDelay: `${i * 180}ms` }}
        />
      ))}
    </div>
  );
}

function Chevron({ up }: { up: boolean }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: up ? "rotate(180deg)" : undefined }}
      aria-hidden="true"
    >
      <path d="m18 15-6-6-6 6" />
    </svg>
  );
}

/** One line of the flowing transcript — speaker is conveyed by weight/opacity, not a box. */
function ThreadLine({
  message,
  floating,
}: {
  message: ShellMessage;
  floating?: boolean;
}): React.JSX.Element {
  const isUser = message.role === "user";
  return (
    <p
      className={cn(
        "text-[14px] leading-relaxed",
        floating ? "mb-1.5" : "mb-3",
        // User turns: quieter + italic, but a touch of top space so a short user
        // line reads as its own turn, not a caption for the reply beneath it.
        isUser ? "italic text-white/70" : "text-white/90",
        !floating && isUser && "mt-1",
        floating && FLOAT_SHADOW,
        floating && !isUser && "text-white/80",
      )}
    >
      {message.content}
    </p>
  );
}

export function ContinuousChatOverlay({
  controller,
}: {
  controller: ShellController;
}): React.JSX.Element {
  const {
    messages,
    phase,
    send,
    canSend,
    recording,
    toggleRecording,
    transcript,
  } = controller;

  const [draft, setDraft] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [whisperVisible, setWhisperVisible] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const threadRef = React.useRef<HTMLDivElement>(null);
  const focusThreadRef = React.useRef(false);

  const visibleMessages = messages.filter((m) => m.content.trim());
  const recent = visibleMessages.slice(-3);
  const lastId = visibleMessages.at(-1)?.id ?? null;
  const seenIdRef = React.useRef(lastId);

  const booting = phase === "booting";
  const listening = phase === "listening";
  const responding = phase === "responding";

  // Whisper: when a genuinely NEW line arrives while collapsed, surface the
  // recent lines for 12s. Keyed on the last message id (not length, and the
  // `expanded` dep early-returns) so toggling the panel never re-triggers it.
  React.useEffect(() => {
    if (lastId === seenIdRef.current) return;
    seenIdRef.current = lastId;
    if (expanded) return;
    setWhisperVisible(true);
    const timer = window.setTimeout(() => setWhisperVisible(false), 12000);
    return () => window.clearTimeout(timer);
  }, [lastId, expanded]);

  React.useEffect(() => {
    if (expanded) setWhisperVisible(false);
  }, [expanded]);

  // messages.length and expanded are intentional triggers: re-scroll to the
  // latest line whenever the thread grows or the panel expands (body reads refs).
  // biome-ignore lint/correctness/useExhaustiveDependencies: triggers, not reads
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
    if (expanded && focusThreadRef.current) {
      threadRef.current?.focus();
      focusThreadRef.current = false;
    }
  }, [messages.length, expanded]);

  const submit = React.useCallback(() => {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft("");
    send(text);
    setExpanded(true);
    inputRef.current?.focus();
  }, [draft, canSend, send]);

  const hasThread = visibleMessages.length > 0;

  const toggleExpand = React.useCallback(() => {
    setExpanded((e) => {
      // Only arm the focus move when there's actually a thread to focus into.
      if (!e && hasThread) focusThreadRef.current = true;
      return !e;
    });
  }, [hasThread]);

  const collapse = React.useCallback(() => {
    setExpanded(false);
    inputRef.current?.focus();
  }, []);

  const sendDisabled = !draft.trim() || !canSend;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 flex flex-col items-center px-4 pb-[calc(var(--safe-area-bottom,0px)+1.5rem)]"
      style={{ zIndex: Z_SHELL_OVERLAY }}
      data-testid="continuous-chat-overlay"
    >
      {/* Cinematic bottom vignette — grounds the floating bar and gives the
          whisper/transcript lines something to read against over bright views. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/45 via-black/15 to-transparent"
      />

      {/* Expanded — the one continuous thread, as a single flowing transcript */}
      {expanded && hasThread ? (
        <div
          id="continuous-thread"
          ref={threadRef}
          role="log"
          aria-label="conversation history"
          aria-live="polite"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable log region must be keyboard-focusable so it can be arrow/Page scrolled (WCAG 2.1.1)
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              collapse();
            }
          }}
          className={cn(
            GLASS_SHEET,
            "pointer-events-auto relative mb-3 max-h-[58vh] w-full max-w-xl overflow-y-auto px-5 py-4",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          )}
        >
          {visibleMessages.map((m) => (
            <ThreadLine key={m.id} message={m} />
          ))}
          {responding ? <TypingDots /> : null}
          <div ref={endRef} />
        </div>
      ) : null}

      {/* Whisper — recent lines dissolve in/out over whatever view is behind.
          Kept mounted (when collapsed + present) and faded via opacity so the
          transition actually plays in BOTH directions, rather than snapping. */}
      {!expanded && recent.length > 0 ? (
        <div
          aria-live="polite"
          className={cn(
            "pointer-events-none relative mb-4 flex w-full max-w-xl flex-col transition-opacity duration-1000",
            whisperVisible ? "opacity-100" : "opacity-0",
          )}
        >
          {recent.map((m) => (
            <ThreadLine key={m.id} message={m} floating />
          ))}
        </div>
      ) : null}
      {!expanded && responding ? (
        <div className="relative mb-4 w-full max-w-xl pl-12">
          <TypingDots />
        </div>
      ) : null}

      {/* Live interim transcript while listening */}
      {recording && transcript ? (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            "pointer-events-none relative mb-2 w-full max-w-xl text-center text-sm italic text-white/85",
            FLOAT_SHADOW,
          )}
        >
          {transcript}
          <span aria-hidden="true">…</span>
        </div>
      ) : null}

      {/* The always-present ambient composer (the heart of the layer) */}
      <div className="pointer-events-auto relative w-full max-w-xl">
        {/* Soft breath of light for live states — not a brand-colored alert ring.
            Always mounted; only opacity changes so it swells in/out over 700ms. */}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -inset-3 rounded-full blur-2xl transition-opacity duration-700",
            listening || responding ? "opacity-100" : "opacity-0",
            listening
              ? "bg-[rgba(255,180,120,0.32)]"
              : "bg-[rgba(190,210,255,0.22)]",
          )}
        />
        <div className={cn(GLASS_BAR, "relative")}>
          <button
            type="button"
            aria-label={
              expanded ? "collapse conversation" : "expand conversation"
            }
            aria-expanded={expanded}
            aria-controls={
              expanded && hasThread ? "continuous-thread" : undefined
            }
            onClick={toggleExpand}
            className={cn(
              "grid h-8 w-7 shrink-0 place-items-center rounded-full text-white/70 transition-colors hover:text-white",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
            )}
          >
            <Chevron up={expanded} />
          </button>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && expanded) {
                e.preventDefault();
                setExpanded(false);
              }
            }}
            placeholder={booting ? "connecting…" : "say anything…"}
            aria-label="message"
            aria-describedby={booting ? "cc-booting-hint" : undefined}
            aria-disabled={booting}
            readOnly={booting}
            className="min-w-0 flex-1 border-none bg-transparent text-sm text-white/[0.92] outline-none placeholder:text-white/45"
          />
          <span id="cc-booting-hint" className="sr-only">
            connecting — you can’t send yet
          </span>
          <SoftButton
            glyph={MIC_GLYPH}
            label={recording ? "stop listening" : "talk"}
            active={recording}
            disabled={booting}
            onClick={toggleRecording}
          />
          <SoftButton
            glyph={SEND_GLYPH}
            label={canSend ? "send" : "send (waiting for reply)"}
            disabled={sendDisabled}
            onClick={submit}
          />
        </div>
      </div>
    </div>
  );
}
