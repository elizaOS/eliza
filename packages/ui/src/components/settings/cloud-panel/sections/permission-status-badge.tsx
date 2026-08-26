/** Maps permission grant state to the canonical status-badge vocabulary. */

import type * as React from "react";
import { StatusBadge } from "../../../ui/status-badge";

export interface PermissionStatusBadgeProps {
  granted: boolean;
}

export function PermissionStatusBadge({
  granted,
}: PermissionStatusBadgeProps): React.JSX.Element {
  return (
    <StatusBadge
      status={granted ? "success" : "muted"}
      label={granted ? "Granted" : "Not granted"}
      presentation="pill"
      withDot
    />
  );
}
