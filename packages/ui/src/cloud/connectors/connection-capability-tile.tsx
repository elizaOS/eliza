/**
 * Presents one provider capability inside a connector setup grid. Provider
 * screens supply translated content and an identifying icon while this
 * molecule owns the shared tile geometry and text hierarchy.
 */

import type { ReactNode } from "react";
import { Card } from "../../components/ui/card";

export interface ConnectionCapabilityTileProps {
  description: string;
  icon: ReactNode;
  title: string;
}

export function ConnectionCapabilityTile({
  description,
  icon,
  title,
}: ConnectionCapabilityTileProps) {
  return (
    <Card
      variant="accountCard"
      padding="compact"
      radius="large"
      className="flex min-w-0 items-center gap-3 text-left"
    >
      <div className="flex size-8 shrink-0 items-center justify-center text-[color:var(--settings-muted)] [&>svg]:size-[18px]">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-5 text-[color:var(--settings-foreground)]">
          {title}
        </p>
        <p className="text-xs leading-4 text-[color:var(--settings-muted)]">
          {description}
        </p>
      </div>
    </Card>
  );
}
