import * as React from "react";

import type { ImageAttachment } from "../../api/client-types-chat";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import {
  filesToImageAttachments,
  MAX_CHAT_IMAGES,
} from "../../utils/image-attachment";
import type { ShellMessage } from "./shell-state";
import { usePromptSuggestions } from "./usePromptSuggestions";
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
const PLUS_GLYPH = "M16 8H20V16H28V20H20V28H16V20H8V16H16Z";
// Two diagonal expand arrows (top-right + bottom-left) — "open in full page".
const MAXIMIZE_GLYPH =
  "M20 8H28V16H25V13.1L18.5 19.6L16.4 17.5L22.9 11H20Z " +
  "M16 28H8V20H11V22.9L17.5 16.4L19.6 18.5L13.1 25H16Z";

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
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  disabled,
  active,
  testId,
}: {
  glyph: string;
  label: string;
  onClick?: () => void;
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerUp?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerCancel?: React.PointerEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  active?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-pressed={active}
      // aria-disabled (not the native attr) so the button stays focusable and its
      // label/reason is announceable; the click is guarded instead.
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      onPointerDown={disabled ? undefined : onPointerDown}
      onPointerUp={disabled ? undefined : onPointerUp}
      onPointerCancel={disabled ? undefined : onPointerCancel}
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

/** Chevron for the inline expand/collapse affordance inside the composer bar. */
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

/** One turn of the transcript as a chat bubble — assistant on the left, user on the right. */
function ThreadLine({
  message,
  floating,
}: {
  message: ShellMessage;
  floating?: boolean;
}): React.JSX.Element {
  const isUser = message.role === "user";
  return (
    <div
      data-testid="thread-line"
      data-role={message.role}
      className={cn(
        "flex w-full",
        floating ? "mb-1.5" : "mb-2.5",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed",
          // Inside the expanded glass sheet, light bubbles read against the dark
          // scrim; floating (whisper) bubbles carry their own dark glass so they
          // stay legible over whatever view is behind.
          isUser ? "rounded-br-md" : "rounded-bl-md",
          floating
            ? cn(
                "border backdrop-blur-md",
                isUser
                  ? "border-white/15 bg-black/55 text-white"
                  : "border-white/10 bg-black/45 text-white/90",
                FLOAT_SHADOW,
              )
            : isUser
              ? "bg-white/20 text-white"
              : "bg-white/10 text-white/90",
        )}
      >
        {message.content}
      </div>
    </div>
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
    startRecording,
    stopRecording,
    transcript,
  } = controller;

  const [draft, setDraft] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [whisperVisible, setWhisperVisible] = React.useState(false);
  const [pushToTalkActive, setPushToTalkActive] = React.useState(false);
  const [pendingImages, setPendingImages] = React.useState<ImageAttachment[]>(
    [],
  );
  const [imageError, setImageError] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const threadRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLDivElement>(null);
  const focusThreadRef = React.useRef(false);
  const pushToTalkTimerRef = React.useRef<number | null>(null);
  const pushToTalkActiveRef = React.useRef(false);
  const suppressMicClickRef = React.useRef(false);

  const visibleMessages = messages.filter((m) => m.content.trim());
  const recent = visibleMessages.slice(-3);
  const lastId = visibleMessages.at(-1)?.id ?? null;
  const seenIdRef = React.useRef(lastId);

  const booting = phase === "booting";
  const listening = phase === "listening";
  const responding = phase === "responding";
  const hasDraft = draft.trim().length > 0;
  const hasImages = pendingImages.length > 0;

  // Five tailored prompt suggestions for the resting overlay (pure/client-side).
  const suggestions = usePromptSuggestions(messages);

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

  React.useEffect(
    () => () => {
      if (pushToTalkTimerRef.current !== null) {
        window.clearTimeout(pushToTalkTimerRef.current);
      }
    },
    [],
  );

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
    const images = pendingImages;
    // An image-only turn is valid; only bail when there's nothing to send.
    if ((!text && images.length === 0) || !canSend) return;
    setDraft("");
    setPendingImages([]);
    setImageError(null);
    if (images.length) {
      send(text, { images });
    } else {
      send(text);
    }
    setExpanded(true);
    inputRef.current?.focus();
  }, [draft, pendingImages, canSend, send]);

  // Tapping a suggestion sends it immediately (same path as submit), so the
  // strip is a one-tap shortcut, not just a draft pre-fill.
  const pickSuggestion = React.useCallback(
    (text: string) => {
      if (!canSend) return;
      setDraft("");
      send(text);
      setExpanded(true);
      inputRef.current?.focus();
    },
    [canSend, send],
  );

  const addImageFiles = React.useCallback((files: FileList | File[]) => {
    void filesToImageAttachments(files)
      .then((attachments) => {
        if (!attachments.length) return;
        setImageError(null);
        setPendingImages((prev) =>
          [...prev, ...attachments].slice(0, MAX_CHAT_IMAGES),
        );
      })
      .catch((err: unknown) => {
        // Surface the failure inline rather than silently dropping the image —
        // the overlay is pure, so it can't reach the global notice channel.
        setImageError(
          err instanceof Error ? err.message : "Couldn't read image",
        );
      });
  }, []);

  const removeImage = React.useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearPushToTalkTimer = React.useCallback(() => {
    if (pushToTalkTimerRef.current === null) return;
    window.clearTimeout(pushToTalkTimerRef.current);
    pushToTalkTimerRef.current = null;
  }, []);

  const beginPushToTalkPress = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (hasDraft || recording || booting || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      clearPushToTalkTimer();
      pushToTalkTimerRef.current = window.setTimeout(() => {
        pushToTalkTimerRef.current = null;
        pushToTalkActiveRef.current = true;
        setPushToTalkActive(true);
        startRecording();
      }, 200);
    },
    [booting, clearPushToTalkTimer, hasDraft, recording, startRecording],
  );

  const endPushToTalkPress = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      clearPushToTalkTimer();
      if (!pushToTalkActiveRef.current) return;
      suppressMicClickRef.current = true;
      pushToTalkActiveRef.current = false;
      setPushToTalkActive(false);
      stopRecording();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [clearPushToTalkTimer, stopRecording],
  );

  const handleMicClick = React.useCallback(() => {
    if (suppressMicClickRef.current) {
      suppressMicClickRef.current = false;
      return;
    }
    toggleRecording();
  }, [toggleRecording]);

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

  // Open the full-page chat view. The overlay reflects the app's single active
  // conversation, and /chat renders that same thread, so a plain navigate keeps
  // the user on the same conversation — no id to carry through the controller.
  const openFullChat = React.useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", {
        detail: { viewId: "chat", viewPath: "/chat" },
      }),
    );
  }, []);

  // Click into the composer → reveal the thread, but keep keyboard focus in the
  // input (don't arm the thread-focus move) so the user can type immediately.
  const expand = React.useCallback(() => {
    if (!hasThread) return;
    setExpanded(true);
  }, [hasThread]);

  // Click anywhere outside the chat surface (composer, thread, or the top
  // chat-icon) → hide the thread. The overlay root is pointer-events-none, so a
  // document-level listener catches clicks that land on the live view behind.
  React.useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (
        threadRef.current?.contains(target) ||
        composerRef.current?.contains(target)
      ) {
        return;
      }
      setExpanded(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [expanded]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 flex flex-col items-center px-4 pb-[calc(var(--eliza-mobile-nav-offset,0px)+var(--safe-area-bottom,0px)+1.5rem)]"
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
            "pointer-events-auto relative mb-3 max-h-[58vh] w-full max-w-3xl overflow-y-auto px-5 py-4",
            // No visible scrollbar — the thread still scrolls, the chrome just hides.
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
          // Hidden from the a11y tree once faded out: opacity-0 alone leaves the
          // stale lines browseable to screen readers. aria-hidden flips false in
          // the same commit a new line arrives (whisperVisible→true), so the new
          // line still announces; it just isn't left exposed during the fade-out.
          aria-hidden={!whisperVisible}
          className={cn(
            "pointer-events-none relative mb-4 flex w-full max-w-3xl flex-col transition-opacity duration-1000",
            whisperVisible ? "opacity-100" : "opacity-0",
          )}
        >
          {recent.map((m) => (
            <ThreadLine key={m.id} message={m} floating />
          ))}
        </div>
      ) : null}
      {!expanded && responding ? (
        <div className="relative mb-4 w-full max-w-3xl pl-12">
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
            "pointer-events-none relative mb-2 w-full max-w-3xl text-center text-sm italic text-white/85",
            FLOAT_SHADOW,
          )}
        >
          {transcript}
          <span aria-hidden="true">…</span>
        </div>
      ) : null}

      {/* Five tailored prompt suggestions — keyboard-strip style, shown only on
          the resting overlay (collapsed, ready, nothing typed/attached, not
          listening) so they invite a first move without ever crowding an active
          conversation. Tapping one sends it immediately. */}
      {!expanded &&
      !recording &&
      !booting &&
      canSend &&
      !hasDraft &&
      !hasImages ? (
        <div
          className="pointer-events-auto relative mb-2 flex w-full max-w-3xl flex-wrap items-center justify-center gap-2"
          data-testid="chat-suggestions"
        >
          {suggestions.map((s, i) => (
            <button
              key={s}
              type="button"
              data-testid={`chat-suggestion-${i}`}
              aria-label={s}
              onClick={() => pickSuggestion(s)}
              className={cn(
                "max-w-full truncate rounded-full border border-white/15 bg-black/40 px-3.5 py-1.5",
                "text-[13px] text-white/80 backdrop-blur-xl transition-colors",
                "shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_10px_30px_-12px_rgba(0,0,0,0.6)]",
                "hover:border-white/30 hover:bg-white/15 hover:text-white",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
              )}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {/* The always-present ambient composer (the heart of the layer) */}
      <div
        ref={composerRef}
        className="pointer-events-auto relative w-full max-w-3xl"
      >
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
        {/* Pending image attachments + any read error, above the bar. */}
        {hasImages || imageError ? (
          <div className="relative mb-2 flex flex-col gap-1.5">
            {hasImages ? (
              <div className="flex flex-wrap gap-2">
                {pendingImages.map((img, i) => (
                  <div
                    key={`${img.name}-${img.mimeType}-${img.data.length}`}
                    className="group relative h-14 w-14 shrink-0"
                  >
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt={img.name}
                      className="h-14 w-14 rounded-lg border border-white/20 object-cover"
                    />
                    <button
                      type="button"
                      aria-label={`remove ${img.name}`}
                      onClick={() => removeImage(i)}
                      className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-white/20 bg-black/70 text-xs text-white/90 backdrop-blur transition-colors hover:bg-black/90"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {imageError ? (
              <p
                role="alert"
                className={cn("text-xs text-red-200/90", FLOAT_SHADOW)}
              >
                {imageError}
              </p>
            ) : null}
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addImageFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div className={cn(GLASS_BAR, "relative")}>
          {/* Inline expand/collapse — a quiet chevron that dissolves into the
              bar, not a separate floating button. */}
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
          <SoftButton
            glyph={MAXIMIZE_GLYPH}
            label="open full chat"
            onClick={openFullChat}
            testId="chat-composer-open-full"
          />
          <SoftButton
            glyph={PLUS_GLYPH}
            label="attach image"
            disabled={booting || pendingImages.length >= MAX_CHAT_IMAGES}
            onClick={() => fileInputRef.current?.click()}
            testId="chat-composer-attach"
          />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={expand}
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
            data-testid="chat-composer-textarea"
            aria-describedby={booting ? "cc-booting-hint" : undefined}
            aria-disabled={booting}
            readOnly={booting}
            className="min-w-0 flex-1 border-none bg-transparent text-sm text-white/[0.92] outline-none placeholder:text-white/45"
          />
          <span id="cc-booting-hint" className="sr-only">
            connecting — you can’t send yet
          </span>
          {/* One trailing control, ChatGPT-style: mic when there's nothing to
              send (or while recording, to stop), swapping to send once the user
              starts typing or attaches an image. */}
          {(hasDraft || hasImages) && !recording ? (
            <SoftButton
              glyph={SEND_GLYPH}
              label={canSend ? "send" : "send (waiting for reply)"}
              disabled={!canSend}
              onClick={submit}
              testId="chat-composer-action"
            />
          ) : (
            <SoftButton
              glyph={MIC_GLYPH}
              label={
                pushToTalkActive
                  ? "release to send"
                  : recording
                    ? "stop listening"
                    : "talk"
              }
              active={recording}
              disabled={booting}
              onClick={handleMicClick}
              onPointerDown={beginPushToTalkPress}
              onPointerUp={endPushToTalkPress}
              onPointerCancel={endPushToTalkPress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
