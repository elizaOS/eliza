/**
 * Bridges view headers to the mobile workspace sidebar trigger supplied by the
 * surrounding page layout.
 */
import { PanelLeftOpen } from "lucide-react";
import type * as React from "react";

import type { WorkspaceMobileSidebarControl } from "../../layouts/workspace-layout/workspace-mobile-sidebar-controls.hooks";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * Compact mobile sidebar trigger for the `ViewHeader` `right` slot.
 *
 * Replaces PageLayout's inline mobile drawer trigger — the lone outlined
 * button that used to render between the centered view header and the
 * content on mobile. A view wraps its sidebar layout in
 * `WorkspaceMobileSidebarScope` (which suppresses the inline button) and
 * renders this control in its header instead.
 *
 * Mirrors the inline trigger's visibility rules: renders nothing on desktop
 * (no drawer registers there) and nothing while the drawer is open (the
 * drawer owns its close affordance). Keeps the documented
 * `page-layout-mobile-sidebar-trigger` testid so existing drawer-opening
 * helpers keep working unchanged.
 */
export function ViewHeaderSidebarTrigger({
  control,
  label,
  className,
}: {
  /** Registered drawer from `useWorkspaceMobileSidebarHeader` (null hides). */
  control: WorkspaceMobileSidebarControl | null;
  /** Override the drawer's registered label (the sidebar `mobileTitle`). */
  label?: React.ReactNode;
  className?: string;
}): React.JSX.Element | null {
  if (!control || control.open) return null;
  const triggerLabel = label ?? control.label ?? "Browse";
  return (
    <Button
      variant="surface"
      size="compact"
      shape="circle"
      type="button"
      data-testid="page-layout-mobile-sidebar-trigger"
      onClick={() => control.setOpen(true)}
      className={cn("max-w-[9rem]", className)}
    >
      <PanelLeftOpen className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{triggerLabel}</span>
    </Button>
  );
}
