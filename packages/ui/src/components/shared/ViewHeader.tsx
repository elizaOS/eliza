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
import { shellHistory } from "../../surface-realm-channel";

/**
 * Return to the launcher grid — the default "back" for any top-level view.
 *
 * The global corner back button was removed (#11876); each view now owns its
 * own header + back control (this module). Back always lands on the launcher
 * surface: set the shell-surface rail to its launcher half, then route to
 * `/views` (which mounts the launcher grid — `/apps` is now the My Apps
 * management view). One helper so every view agrees.
 */
export function navigateBackToLauncher(): void {
  goLauncher();
  if (typeof window === "undefined") return;
  const path = "/views";
  try {
    if (shouldUseHashNavigation()) {
      window.location.hash = path;
    } else {
      shellHistory.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  } catch {
    // Sandboxed navigation is best-effort.
  }
}

/**
 * The shared view back button: an icon, nothing else. Deliberately chromeless —
 * no border, no shadow, no filled circle, and NO rest-state fill so it reads as
 * a bare icon on every surface (#13451/#13586: the normal-view header back
 * affordance is icon-only, with no border/background/circle at rest). Fixing
 * the primitive fixes every consumer at once. A subtle neutral `bg-hover` chip
 * (square-cornered `rounded-md`, NOT the old `rounded-full` disc) only appears
 * on hover for affordance, never in the resting state. Focus styling is NOT
 * sprinkled here: it is centralized in CSS (`--focus`) per the no-focus-ring
 * gate, so this primitive carries no `focus`/`ring` utilities.
 */
export function ViewBackButton({
  onBack,
  label = "Back to launcher",
  className,
}: {
  onBack?: () => void;
  /** Accessible + agent label. Sub-views override this to name their target
   *  (e.g. a Settings section returning to the hub uses "Back to Settings"). */
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
  // The BUTTON is the hit target and must meet the 44px mobile minimum on its
  // own box (#13586 / #14152 — a tap target borrowed from the surrounding row
  // is not clickable-by-contract). h-11 w-11 with -m-1 keeps the 36px layout
  // footprint; the visual affordance (36px hover chip) lives on the inner span
  // so the resting/hover appearance is unchanged.
  return (
    <button
      ref={ref}
      type="button"
      onClick={handleBack}
      aria-label={label}
      className={cn(
        "group -m-1 inline-flex h-11 w-11 items-center justify-center bg-transparent text-txt",
        className,
      )}
      {...agentProps}
    >
      <span className="inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors group-hover:bg-bg-hover">
        <ArrowLeft className="h-5 w-5" aria-hidden />
      </span>
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
  backLabel,
  showBack = true,
  right,
  className,
}: {
  title: ReactNode;
  /** Override the default (launcher) back target — e.g. a sub-view returning to its hub. */
  onBack?: () => void;
  /** Accessible + agent label for the back control. Defaults to the launcher
   *  wording; a sub-view returning to its hub should name that hub (e.g.
   *  "Back to Settings") so the icon-only button is announced correctly. */
  backLabel?: string;
  /** Hide the back control entirely (a view with no meaningful "back"). */
  showBack?: boolean;
  /** Optional trailing controls (actions, filters). */
  right?: ReactNode;
  className?: string;
}) {
  // Title is centered over the FULL header width, not within a grid track, so
  // it stays optically centered regardless of how wide the back button or the
  // trailing actions are (#13451: view title is centered in the header). The
  // controls float at the edges of a `relative` row and the `<h1>` is a
  // non-responsive `absolute inset-x-0` centered layer. It uses a single,
  // static `absolute` (unlike the responsive position variants that
  // historically did not survive the app's Tailwind build). The title reserves
  // symmetric side room (`px-12`, wider than the icon back button) and
  // truncates, so a long title never slides under the edge controls; the flex
  // controls sit above it (`z-10`, pointer-events on) and stay clickable while
  // the title layer is `pointer-events-none`.
  return (
    <header
      data-testid="view-header"
      className={cn(
        "relative flex min-h-14 shrink-0 items-center justify-between gap-1 px-3 py-2.5 sm:gap-2 sm:px-4",
        className,
      )}
    >
      {showBack ? (
        <ViewBackButton onBack={onBack} label={backLabel} />
      ) : (
        <span aria-hidden />
      )}
      <h1 className="pointer-events-none absolute inset-x-0 mx-auto max-w-[calc(100%-6rem)] truncate px-12 text-center text-lg font-semibold tracking-tight text-txt-strong">
        {title}
      </h1>
      {right ? (
        <div className="relative z-10">{right}</div>
      ) : (
        <span aria-hidden />
      )}
    </header>
  );
}
