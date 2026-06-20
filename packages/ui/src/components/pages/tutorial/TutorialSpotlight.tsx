import { Volume2, VolumeX } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

/**
 * The tour spotlight: a full-screen overlay that
 *  - draws a breathing orange glow ring around the target (the indicator that
 *    points at the next control);
 *  - floats a small instruction card near the target (auto-flips above/below);
 *  - for a centered card (welcome / finish) dims the whole screen instead.
 *
 * Brand orange (#FF5800) is the only accent; resting→hover stays orange→darker.
 */

const BRAND = "#FF5800";
const PAD = 8; // glow ring inset around the target

export interface SpotlightCardProps {
  title: string;
  body: string;
  /** Narration muted — toggles the speaker control. */
  muted: boolean;
  onToggleMute: () => void;
  onSkip: () => void;
  /** Optional manual-advance button (centered cards, or a stalled frame). */
  onContinue?: () => void;
  continueLabel?: string;
}

export interface TutorialSpotlightProps extends SpotlightCardProps {
  /** CSS selector for the element to spotlight, or null for a centered card. */
  targetSelector: string | null;
  /** Dim the whole screen behind a centered card. */
  blockOutside: boolean;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function measure(selector: string | null): Rect | null {
  if (!selector || typeof document === "undefined") return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function TutorialSpotlight({
  targetSelector,
  blockOutside,
  ...card
}: TutorialSpotlightProps): React.ReactPortal | null {
  const [rect, setRect] = React.useState<Rect | null>(() =>
    measure(targetSelector),
  );

  // Follow the target as it moves/resizes/scrolls (rAF loop is the simplest
  // reliable tracker across layout shifts, animations, and the chat expanding).
  React.useEffect(() => {
    if (!targetSelector) {
      setRect(null);
      return;
    }
    let raf = 0;
    let prev = "";
    const tick = () => {
      const next = measure(targetSelector);
      const sig = next
        ? `${Math.round(next.top)},${Math.round(next.left)},${Math.round(next.width)},${Math.round(next.height)}`
        : "";
      if (sig !== prev) {
        prev = sig;
        setRect(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [targetSelector]);

  if (typeof document === "undefined") return null;

  const hole = rect
    ? {
        top: Math.max(0, rect.top - PAD),
        left: Math.max(0, rect.left - PAD),
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : null;

  // Card placement: centered when there's no target. For a target in the BOTTOM
  // of the screen (e.g. the chat — which also expands upward), pin the card near
  // the TOP so it never covers the control or sits in the chat's expand path.
  // Otherwise place it just below the target, or above when there's no room.
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const cardStyle: React.CSSProperties = !hole
    ? { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
    : hole.top > vh * 0.55
      ? {
          top: Math.max(72, Math.round(vh * 0.12)),
          left: "50%",
          transform: "translateX(-50%)",
        }
      : hole.top + hole.height + 180 < vh
        ? { top: hole.top + hole.height + 14, left: clampLeft(hole.left) }
        : { top: Math.max(14, hole.top - 172), left: clampLeft(hole.left) };

  return createPortal(
    <div
      className="fixed inset-0"
      // Inline z-index (not a Tailwind arbitrary class — that huge value isn't
      // reliably generated) so the spotlight + card always sit ABOVE the chat
      // overlay (z 9000), even when the chat is expanded full-screen while the
      // user performs the instructed action. Clicks pass through except the card.
      style={{ pointerEvents: "none", zIndex: 2147483000 }}
      aria-live="polite"
    >
      <style>{SPOTLIGHT_KEYFRAMES}</style>

      {/* Dim everything except the target so it pops on ANY background — the
          bright-orange /chat ambient would otherwise swallow an orange glow ring.
          With a target: four rects framing a hole (the target stays clickable,
          and a drag started on it keeps pointer capture); without one: a single
          full-screen dim behind the centered card. */}
      {blockOutside &&
        (hole ? (
          <BackdropWithHole hole={hole} />
        ) : (
          <div
            className="absolute inset-0 bg-black/55"
            style={{ pointerEvents: "auto" }}
          />
        ))}

      {/* The breathing glow ring around the target. */}
      {hole && (
        <div
          className="absolute rounded-xl"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            pointerEvents: "none",
            boxShadow: `0 0 0 2px ${BRAND}, 0 0 0 9999px rgba(0,0,0,0)`,
            animation: "tutorial-glow 1.6s ease-in-out infinite",
          }}
        />
      )}

      <SpotlightCard {...card} cardStyle={cardStyle} />
    </div>,
    document.body,
  );
}

function clampLeft(left: number): number {
  const w = 320;
  return Math.min(Math.max(14, left), window.innerWidth - w - 14);
}

/** Four dim rects framing the target hole; each blocks clicks. The hole is left
 *  open so only the intended control is interactive. */
function BackdropWithHole({ hole }: { hole: Rect }): React.ReactElement {
  const dim = "absolute bg-black/55";
  const block: React.CSSProperties = { pointerEvents: "auto" };
  return (
    <>
      <div
        className={dim}
        style={{ ...block, top: 0, left: 0, right: 0, height: hole.top }}
      />
      <div
        className={dim}
        style={{
          ...block,
          top: hole.top + hole.height,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      />
      <div
        className={dim}
        style={{
          ...block,
          top: hole.top,
          left: 0,
          width: hole.left,
          height: hole.height,
        }}
      />
      <div
        className={dim}
        style={{
          ...block,
          top: hole.top,
          left: hole.left + hole.width,
          right: 0,
          height: hole.height,
        }}
      />
    </>
  );
}

function SpotlightCard({
  title,
  body,
  muted,
  onToggleMute,
  onSkip,
  onContinue,
  continueLabel,
  cardStyle,
}: SpotlightCardProps & {
  cardStyle: React.CSSProperties;
}): React.ReactElement {
  return (
    <div
      className="absolute w-[300px] max-w-[calc(100vw-28px)] rounded-2xl border border-white/12 bg-neutral-950/95 p-4 text-white shadow-2xl backdrop-blur-md motion-safe:animate-[shell-overlay-in_220ms_ease-out]"
      style={{ ...cardStyle, pointerEvents: "auto" }}
      data-testid="tutorial-card"
      role="dialog"
      aria-label="Tour step"
    >
      <h3 className="text-[15px] font-semibold leading-snug">{title}</h3>
      <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-white/75">
        {body}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onToggleMute}
            data-testid="tutorial-mute"
            aria-label={muted ? "Unmute narration" : "Mute narration"}
            aria-pressed={muted}
            className="text-white/45 transition-colors hover:text-white/80"
          >
            {muted ? (
              <VolumeX className="h-4 w-4" aria-hidden />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden />
            )}
          </button>
          <button
            type="button"
            onClick={onSkip}
            data-testid="tutorial-skip"
            className="text-[12px] text-white/45 underline-offset-2 hover:text-white/70 hover:underline"
          >
            Skip tour
          </button>
        </div>
        {onContinue && (
          <button
            type="button"
            onClick={onContinue}
            data-testid="tutorial-continue"
            className="rounded-lg px-3 py-1.5 text-[13px] font-semibold text-white transition-colors"
            style={{ backgroundColor: BRAND }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "#D44A00";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = BRAND;
            }}
          >
            {continueLabel ?? "Continue"}
          </button>
        )}
      </div>
    </div>
  );
}

const SPOTLIGHT_KEYFRAMES = `
@keyframes tutorial-glow {
  0%, 100% { box-shadow: 0 0 0 2px ${BRAND}, 0 0 14px 3px rgba(255,88,0,0.55); }
  50%      { box-shadow: 0 0 0 3px ${BRAND}, 0 0 26px 8px rgba(255,88,0,0.85); }
}
@media (prefers-reduced-motion: reduce) {
  [style*="tutorial-glow"] { animation: none !important; }
}
`;
