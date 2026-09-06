/**
 * Renders the standard view header slots used by dashboard pages, including
 * mobile sidebar affordances.
 */
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useAgentElement } from "../../agent-surface";
import { cn } from "../../lib/utils";
import { shouldUseHashNavigation } from "../../navigation";
import { shellHistory } from "../../surface-realm-channel";
import { Button } from "../ui/button";

/**
 * Return to the combined home/apps surface — the default "back" for any
 * top-level view. `/views` keeps the launcher route stable while rendering the
 * same inline apps region used by chat; `/apps` deep-links into the Projects
 * surface's Apps segment (#17031).
 */
export function navigateBackToLauncher(): void {
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
 * on hover for affordance, never in the resting state. Focus rings are banned
 * globally; `keyboard-focus-surface` is the filled accent `:focus-visible`
 * treatment that keeps keyboard position visible without a ring.
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
  // Keep the full 44px hit target; hover brightens only the icon.
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon-lg"
      onClick={handleBack}
      aria-label={label}
      className={cn("keyboard-focus-surface -m-1", className)}
      {...agentProps}
    >
      <ArrowLeft className="size-5" aria-hidden />
    </Button>
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
  // Views no longer repeat a page title and launcher/back button above their
  // content. Keep real page actions (Add, filters, etc.) available without an
  // empty header row when a view has no actions.
  if (!right) return null;
  return (
    <div
      data-testid="view-actions"
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 px-3 py-2 sm:px-4",
        className,
      )}
    >
      {right}
    </div>
  );
}
