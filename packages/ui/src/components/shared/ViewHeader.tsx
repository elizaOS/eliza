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
 * no border, no fill, no shadow, and never the accent/orange chip it used to be.
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
        "inline-flex h-9 w-9 items-center justify-center rounded-full bg-transparent text-txt transition-colors hover:bg-bg-hover",
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
 * The title stays centered with the back button in the left slot (the iOS-style
 * nav bar the redesign asks for). A sub-view renders its OWN `ViewHeader`,
 * which REPLACES this one rather than stacking beneath it — callers swap the
 * header for the active section, they do not nest two.
 */
export function ViewHeader({
  title,
  onBack,
  backLabel,
  showBack = true,
  right,
  className,
}: {
  title: ReactNode;
  /** Override the default (launcher) back target — e.g. a sub-view returning to its hub. */
  onBack?: () => void;
  /** Accessible label for the back control when `onBack` points somewhere custom. */
  backLabel?: string;
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
        "grid min-h-14 shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-1 px-3 py-2.5 sm:gap-2 sm:px-4",
        className,
      )}
    >
      {showBack ? (
        <ViewBackButton label={backLabel} onBack={onBack} />
      ) : (
        <span aria-hidden />
      )}
      <h1 className="justify-self-center truncate text-lg font-semibold tracking-tight text-txt-strong">
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
