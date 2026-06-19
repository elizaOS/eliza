import { useApp } from "../../state";
import { Button } from "../ui/button";

// z-[9998] mirrors Z_SYSTEM_BANNER in ../../lib/floating-layers.ts.
// Kept as a literal so Tailwind v4's source scanner emits the utility.

/**
 * Top-of-shell action banner: a full-width banner above the shell content
 * (not a bottom toast) carrying an optional primary-action CTA. Reuses the
 * SystemWarningBanner styling contract (orange accent, never blue) and the
 * RestartBanner primary-button tokens. One banner at a time, driven by the
 * `actionBanner` app-state slice. The model-required first-run prompt is the
 * sole consumer for now.
 */
export function ActionBanner() {
  const { actionBanner, dismissActionBanner } = useApp();

  if (!actionBanner) return null;

  const { text, actionLabel, onAction } = actionBanner;

  const handleAction = () => {
    onAction?.();
    dismissActionBanner();
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-window-titlebar-banner="true"
      className="shrink-0 z-[9998] flex items-center justify-between gap-3 bg-warn px-4 py-2 text-sm font-medium text-[color:var(--accent-foreground)] "
    >
      <span className="truncate">{text}</span>
      <div className="flex shrink-0 items-center gap-2">
        {actionLabel && onAction ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={handleAction}
            className="rounded-sm px-3 py-0.5 text-xs font-semibold border-transparent"
            style={{
              background: "var(--accent)",
              color: "var(--accent-foreground)",
            }}
          >
            {actionLabel}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={dismissActionBanner}
          className="shrink-0 rounded-sm px-2 py-0.5 text-xs text-[color:var(--accent-foreground)]/80 hover:bg-black/10"
        >
          x
        </Button>
      </div>
    </div>
  );
}
