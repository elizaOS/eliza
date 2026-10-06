/**
 * Renders the standard view header slots used by dashboard pages, including
 * mobile sidebar affordances.
 */
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useAgentElement } from "../../agent-surface/useAgentElement";
import { shouldUseHashNavigation } from "../../navigation";
import { shellHistory } from "../../surface-realm-channel";
import { cn } from "../../utils/cn";
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

/** Renders trailing page actions without an empty row. */
export function ViewHeader({
  right,
  className,
}: {
  right?: ReactNode;
  className?: string;
}) {
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
