/**
 * The tour spotlight: a full-screen overlay that
 *  - draws a breathing glow around the target (the indicator that points at the
 *    next control), painted in the active theme's `--accent`;
 *  - floats a small instruction card near the target (auto-flips above/below);
 *  - for a centered card (welcome / finish) dims the whole screen instead.
 *
 * Every color here reads from theme tokens (`--accent`, `--accent-hover`,
 * `--accent-rgb`, `--card`, …) so the spotlight matches the active brand —
 * orange in the default theme, white/black in the mono themes, gold on the
 * classic brand — instead of hardcoding one accent.
 */
import { Volume2, VolumeX } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { Z_TUTORIAL } from "../../../lib/floating-layers";
import { Button } from "../../ui/button";

const PAD = 8; // glow  inset around the target

export interface SpotlightCardProps {
  /** Active tour frame id — stamped on the card so e2e can drive frame-by-frame. */
  stepId: string;
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
  /**
   * Dim the screen around the target while the step is in progress. PURELY
   * VISUAL — the dim never captures pointer events, so the real UI underneath
   * (the chat input, the mic, every control) always stays tappable. Only the
   * instruction card is interactive.
   */
  dimOutside: boolean;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Resolve the spotlight target. A test id can be present in several conditional
 * branches of a component (e.g. `chat-composer-action` renders in six places of
 * the composer), so the first DOM match is not trustworthy — we pick the first
 * candidate that is actually on-screen (non-zero box, intersecting the
 * viewport). Hidden/unmounted branches collapse to a zero box and are skipped;
 * off-canvas duplicates are skipped. Returns null only when no visible element
 * matches, which the overlay surfaces (a `data-tutorial-target-missing` marker)
 * instead of silently degrading to a full dim.
 */
function measure(selector: string | null): Rect | null {
  if (!selector || typeof document === "undefined") return null;
  const vw = typeof window === "undefined" ? 0 : window.innerWidth;
  const vh = typeof window === "undefined" ? 0 : window.innerHeight;
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const onScreen = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    if (!onScreen) continue;
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }
  return null;
}

export function TutorialSpotlight({
  targetSelector,
  dimOutside,
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

  // A non-null target that resolves to nothing visible means the spotlight can't
  // frame a control this frame — mark it (rather than silently full-dimming) so
  // the e2e and a developer can see the targeting broke.
  const targetMissing = targetSelector != null && rect == null;

  return createPortal(
    <div
      className="fixed inset-0"
      // Z from the registered scale (floating-layers): above the chat/shell
      // overlay (Z_SHELL_OVERLAY 9000) so the spotlight + card always sit over an
      // expanded chat while the user performs the instructed action, but below
      // the system-critical band so a fatal banner is never painted over.
      // Clicks pass through except the card.
      style={{ pointerEvents: "none", zIndex: Z_TUTORIAL }}
      aria-live="polite"
      data-testid="tutorial-spotlight"
      // Marks this layer as painted above the chat glass so the chat's
      // outside-tap swallower cedes taps on the card's interactive children
      // (the root itself is pointer-transparent).
      data-above-shell-overlay
      data-tutorial-target-missing={targetMissing ? targetSelector : undefined}
    >
      <style>{SPOTLIGHT_KEYFRAMES}</style>

      {/* Dim everything except the target so it pops on ANY background — the
          bright-orange /chat ambient would otherwise swallow the glow. This dim
          is PURELY VISUAL: every layer is pointer-events:none, so the chat
          input, the mic, and every control underneath stay tappable. The
          capability lock (nav-lock in TutorialOverlay) — not a click-blocker —
          is what keeps the user from drifting off the expected tab. */}
      {dimOutside &&
        (hole ? (
          <BackdropWithHole hole={hole} />
        ) : (
          <div
            className="absolute inset-0 bg-black/55"
            style={{ pointerEvents: "none" }}
          />
        ))}

      {/* The breathing glow around the target (soft halo, not a hard outlined
          box), painted in the active theme's accent. */}
      {hole && (
        <div
          className="absolute rounded-2xl"
          data-testid="tutorial-glow"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
            pointerEvents: "none",
            boxShadow: "0 0 18px 5px rgba(var(--accent-rgb), 0.5)",
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

/** Four dim rects framing the target hole — a purely visual cut-out so the
 *  target pops. Every rect is pointer-events:none: nothing here blocks input,
 *  so the whole UI underneath (including the chat textarea) stays tappable. */
function BackdropWithHole({ hole }: { hole: Rect }): React.ReactElement {
  const dim = "absolute bg-black/55";
  const passThrough: React.CSSProperties = { pointerEvents: "none" };
  return (
    <>
      <div
        className={dim}
        style={{ ...passThrough, top: 0, left: 0, right: 0, height: hole.top }}
      />
      <div
        className={dim}
        style={{
          ...passThrough,
          top: hole.top + hole.height,
          left: 0,
          right: 0,
          bottom: 0,
        }}
      />
      <div
        className={dim}
        style={{
          ...passThrough,
          top: hole.top,
          left: 0,
          width: hole.left,
          height: hole.height,
        }}
      />
      <div
        className={dim}
        style={{
          ...passThrough,
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
  stepId,
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
      className="absolute w-[300px] max-w-[calc(100vw-28px)] rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-xl motion-safe:animate-[shell-overlay-in_220ms_ease-out]"
      style={{ ...cardStyle, pointerEvents: "auto" }}
      data-testid="tutorial-card"
      data-tutorial-step-id={stepId}
      role="dialog"
      aria-label="Tour step"
    >
      <h3 className="text-[15px] font-semibold leading-snug">{title}</h3>
      <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-muted">
        {body}
      </p>
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Button
            onClick={onToggleMute}
            data-testid="tutorial-mute"
            aria-label={muted ? "Unmute narration" : "Mute narration"}
            aria-pressed={muted}
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 text-muted transition-colors hover:bg-transparent hover:text-card-foreground"
          >
            {muted ? (
              <VolumeX className="h-4 w-4" aria-hidden />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden />
            )}
          </Button>
          <Button
            onClick={onSkip}
            data-testid="tutorial-skip"
            variant="ghost"
            size="sm"
            className="h-auto px-0 py-0 text-[12px] font-normal text-muted underline-offset-2 hover:bg-transparent hover:text-card-foreground hover:underline"
          >
            Skip tour
          </Button>
        </div>
        {onContinue && (
          <Button
            onClick={onContinue}
            data-testid="tutorial-continue"
            className="h-auto rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-foreground)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--accent-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "var(--accent)";
            }}
          >
            {continueLabel ?? "Continue"}
          </Button>
        )}
      </div>
    </div>
  );
}

// @keyframes can't interpolate a `var(--accent)` color, so the breathing glow
// reads `--accent-rgb` (themed per brand in base.css / brand-gold.css) and only
// animates the alpha + spread.
const SPOTLIGHT_KEYFRAMES = `
@keyframes tutorial-glow {
  0%, 100% { box-shadow: 0 0 16px 4px rgba(var(--accent-rgb), 0.45); }
  50%      { box-shadow: 0 0 30px 11px rgba(var(--accent-rgb), 0.8); }
}
@media (prefers-reduced-motion: reduce) {
  [style*="tutorial-glow"] { animation: none !important; }
}
`;
