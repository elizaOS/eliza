/**
 * Renders the standard view header slots used by dashboard pages, including
 * mobile sidebar affordances.
 */
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useAgentElement } from "../../agent-surface";
import { cn } from "../../lib/utils";
import { shouldUseHashNavigation } from "../../navigation";
import { goLauncher } from "../../state/shell-surface-store";

/**
 * Return to the launcher grid — the default "back" for any top-level view.
 *
 * The global corner back button was removed (#11876); each view now owns its
 * own header + back control (this module). Back always lands on the launcher
 * surface: set the shell-surface rail to its launcher half, then route to
 * `/apps` (which mounts the launcher). One helper so every view agrees.
 */
export function navigateBackToLauncher(): void {
  goLauncher();
  if (typeof window === "undefined") return;
  const path = "/apps";
  try {
    if (shouldUseHashNavigation()) {
      window.location.hash = path;
    } else {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  } catch {
    // Sandboxed navigation is best-effort.
  }
}

/**
 * The shared view back button: an icon, nothing else. Deliberately chromeless —
 * no border, no shadow, and a `bg-bg` fill so it reads as the neutral view
 * surface (white in light mode, dark in dark mode), never the accent/orange
 * chip it used to be. On an opaque view the fill is invisible (looks like a
 * bare icon); on a shared-background view it's a subtle neutral chip.
 */
export function ViewBackButton({
  onBack,
  label = "Back to launcher",
  className,
}: {
  onBack?: () => void;
  label?: string;
  className?: string;
}) {
  const handleBack = onBack ?? navigateBackToLauncher;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "view-back",
    role: "button",
    label,
    description: "Return to the launcher",
    onActivate: handleBack,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={handleBack}
      aria-label={label}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full bg-bg text-txt transition-colors hover:bg-bg-hover",
        className,
      )}
      {...agentProps}
    >
      <ArrowLeft className="h-5 w-5" aria-hidden />
    </button>
  );
}

/**
 * Standard view header: a chromeless back button and a title on one line.
 *
 * Mobile centers the title with the back button overlaid on the left (the
 * iOS-style nav bar the redesign asks for); ≥sm left-aligns the title after the
 * back button. A sub-view renders its OWN `ViewHeader`, which REPLACES this one
 * rather than stacking beneath it — callers swap the header for the active
 * section, they do not nest two.
 */
export function ViewHeader({
  title,
  onBack,
  showBack = true,
  right,
  className,
}: {
  title: ReactNode;
  /** Override the default (launcher) back target — e.g. a sub-view returning to its hub. */
  onBack?: () => void;
  /** Hide the back control entirely (a view with no meaningful "back"). */
  showBack?: boolean;
  /** Optional trailing controls (actions, filters). */
  right?: ReactNode;
  className?: string;
}) {
  // A 3-column grid, not absolute positioning: responsive `static`/`relative`
  // position variants do not survive the app's Tailwind build (the base
  // `absolute` always won, leaving the back button detached from the row on
  // desktop), so the layout uses grid tracks + responsive `justify-self`
  // instead. Mobile: fixed equal side tracks keep the title truly centered
  // with the back control on the left. ≥sm: auto tracks left-align the title
  // right after the back button.
  return (
    <header
      data-testid="view-header"
      className={cn(
        "grid min-h-14 shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-1 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:gap-2 sm:px-4",
        className,
      )}
    >
      {showBack ? <ViewBackButton onBack={onBack} /> : <span aria-hidden />}
      <h1 className="justify-self-center truncate text-lg font-semibold tracking-tight text-txt-strong sm:justify-self-start">
        {title}
      </h1>
      {right ? (
        <div className="justify-self-end">{right}</div>
      ) : (
        <span aria-hidden />
      )}
    </header>
  );
}
