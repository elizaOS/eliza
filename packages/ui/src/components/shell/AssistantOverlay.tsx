/**
 * Renders the assistant overlay layer that hosts chat, notifications, and
 * launcher-adjacent surfaces.
 */
import { X } from "lucide-react";
import * as React from "react";

import { useBranding } from "../../config/branding";
import { useNativeGlassAnchor } from "../../glass";
import { Z_SHELL_OVERLAY } from "../../lib/floating-layers";
import { NATIVE_GLASS_DARK_TINT } from "../../themes/native-glass.js";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import type { ShellPhase } from "./shell-state";

export interface AssistantOverlayProps {
  phase: ShellPhase;
  onClose: () => void;
  children: React.ReactNode;
  /** Explicit overlay visibility from the shell's open state. When provided it
   *  overrides the phase-derived fallback — required for the hold-to-talk
   *  quasimode (#20483), where `listening`/`responding` can be active while
   *  the overlay stays closed (pill-only capture). */
  open?: boolean;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Bottom-sheet / centered-drawer container for the assistant chat.
 *
 * - Renders children only when phase ∈ {summoned, listening, responding}
 * - Listens for Escape on `document` to invoke onClose
 * - Aria: role=dialog + aria-modal=true so screen readers announce it
 * - Focus management (WAI-ARIA Dialog pattern):
 *   - On open: remembers the previously focused element and moves focus
 *     into the dialog (first focusable descendant, or the dialog itself).
 *   - While open: Tab and Shift+Tab cycle within the dialog only.
 *   - On close: restores focus to the previously focused element.
 *
 * Animation is a single CSS keyframe (defined in base.css as
 * `@keyframes shell-overlay-in`) on enter; respects
 * `prefers-reduced-motion` via Tailwind's `motion-safe:` prefix.
 */
export function AssistantOverlay({
  phase,
  onClose,
  children,
  open,
}: AssistantOverlayProps): React.JSX.Element | null {
  const { appName } = useBranding();
  const isOpen =
    open ??
    (phase === "summoned" || phase === "listening" || phase === "responding");
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const glassTier = useNativeGlassAnchor(dialogRef, {
    colorScheme: "dark",
    tintColor: NATIVE_GLASS_DARK_TINT,
  });
  const previousFocusRef = React.useRef<HTMLElement | null>(null);

  // Manage Escape, focus trap, initial focus, and focus return as a single
  // effect bound to isOpen so cleanup/setup pair correctly across opens.
  React.useEffect(() => {
    if (!isOpen) return undefined;
    if (typeof document === "undefined") return undefined;

    // Remember where focus was before we steal it.
    previousFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    // Move initial focus into the dialog after mount. The dialog itself has
    // tabIndex={-1} so it can receive programmatic focus if no descendant is
    // focusable yet (e.g., empty ChatSurface with disabled send).
    const dialog = dialogRef.current;
    if (dialog) {
      const firstFocusable =
        dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (firstFocusable ?? dialog).focus();
    }

    function getFocusable(): HTMLElement[] {
      if (!dialog) return [];
      return Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || active === dialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restore focus to the trigger (e.g. the HomePill).
      const previous = previousFocusRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus();
      }
      previousFocusRef.current = null;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      // Sits one tick above the pill in stacking order. The desktop overlay
      // shell also offsets the panel so the two surfaces never overlap.
      // Inline style because Tailwind's JIT can't track template-interpolated
      // arbitrary z-index values. See packages/ui/src/lib/floating-layers.ts.
      // GlassSurface's shared recipe establishes `position: relative` for rim
      // pseudo-elements. This overlay is itself the anchored surface, so keep
      // the fixed-position contract explicit at higher precedence.
      style={{ zIndex: Z_SHELL_OVERLAY + 1 }}
      className="pointer-events-auto fixed inset-x-0 bottom-0 h-[80vh] sm:left-1/2 sm:right-auto sm:top-1/2 sm:bottom-auto sm:h-[min(640px,80vh)] sm:w-[min(560px,90vw)] sm:-translate-x-1/2 sm:-translate-y-1/2"
    >
      <Card
        surface="transparent"
        border="subtle"
        radius="large"
        glass="sheet"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${appName} assistant`}
        data-testid="shell-assistant-overlay"
        data-popup-material="dark-frosted"
        data-phase={phase}
        data-glass-tier={glassTier}
        tokenStyle={{
          "--card": "var(--assistant-overlay-card)",
          "--card-foreground": "var(--assistant-overlay-foreground)",
          "--text": "var(--assistant-overlay-foreground)",
          "--text-strong": "var(--assistant-overlay-strong-foreground)",
          "--txt": "var(--text)",
          "--muted": "var(--assistant-overlay-muted)",
          "--muted-strong": "var(--assistant-overlay-muted-strong)",
          "--foreground": "var(--text)",
          "--muted-foreground": "var(--muted)",
          "--bg": "var(--assistant-overlay-background)",
          "--accent-subtle": "var(--assistant-overlay-accent-subtle)",
        }}
        visualStyle={{
          borderColor: "var(--assistant-overlay-border)",
        }}
        className="shell-assistant-overlay-panel h-full w-full overflow-hidden motion-safe:animate-[shell-overlay-in_220ms_ease-out]"
      >
        <Button
          variant="ghostMuted"
          size="icon-sm"
          aria-label="Close assistant"
          onClick={onClose}
          shape="circle"
          className="absolute right-2 top-2 z-10"
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
        <div className="box-border h-full min-h-0 px-3 pb-2 pt-10">
          {children}
        </div>
      </Card>
    </div>
  );
}
