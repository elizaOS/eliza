/**
 * Compatibility re-export of the field primitives plus the
 * `AdvancedSettingsDisclosure` collapsible for settings sections. The canonical
 * `SettingsField*` primitives live in `../ui/settings-controls`; this module
 * re-exports them for `./settings-control-primitives` importers.
 */

import type * as React from "react";
import { useState } from "react";
import { cn } from "../../lib/utils";

// Field primitives have a single home in the ui layer (settings-controls.tsx).
// Re-exported here so existing `./settings-control-primitives` importers keep
// working without a second implementation drifting out of sync.
export {
  SettingsField,
  SettingsFieldDescription,
  SettingsFieldLabel,
} from "../ui/settings-controls";

export function AdvancedSettingsDisclosure({
  title = "Advanced",
  children,
  className,
  lazy = false,
  defaultOpen = false,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  lazy?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shouldRenderChildren = !lazy || open;

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={cn("group rounded-sm bg-card/45 px-3 py-2", className)}
    >
      <summary className="cursor-pointer select-none list-none text-xs font-medium text-muted transition-colors hover:text-txt">
        {title}
      </summary>
      {shouldRenderChildren ? <div className="mt-3">{children}</div> : null}
    </details>
  );
}
