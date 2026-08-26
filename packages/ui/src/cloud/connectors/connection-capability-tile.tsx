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
    <Card variant="flatPadded" className="p-3 text-center">
      <div className="mx-auto mb-2 flex size-6 items-center justify-center">
        {icon}
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </Card>
  );
}
