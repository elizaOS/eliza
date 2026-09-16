/**
 * Compatibility re-export of the field primitives plus the
 * `AdvancedSettingsDisclosure` collapsible for settings sections. The canonical
 * `SettingsField*` primitives live in `../ui/settings-controls`; this module
 * re-exports them for `./settings-control-primitives` importers.
 */

import type * as React from "react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";

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
    <Card asChild variant="transparent" surface="card" padding="compact">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className={cn("group text-card-fg", className)}
      >
        <CollapsibleTrigger asChild>
          <Button
            variant="ghostMuted"
            size="content"
            className="w-full justify-start"
          >
            {title}
          </Button>
        </CollapsibleTrigger>
        {shouldRenderChildren ? (
          <CollapsibleContent className="mt-3">{children}</CollapsibleContent>
        ) : null}
      </Collapsible>
    </Card>
  );
}
