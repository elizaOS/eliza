import { isPermissionId } from "@elizaos/shared";
import type * as React from "react";

import { PermissionCard, type PermissionCardProps } from "./permission-card";
import type { PermissionCardPayload } from "./permission-card.helpers";

export function renderPermissionCardFromPayload(
  payload: PermissionCardPayload,
  opts: Omit<
    PermissionCardProps,
    "permission" | "reason" | "feature" | "fallbackOffered" | "fallbackLabel"
  > & { key?: string } = {},
): React.ReactElement | null {
  if (!isPermissionId(payload.permission)) return null;
  const { key, ...rest } = opts;
  return (
    <PermissionCard
      key={key ?? `permission-card:${payload.feature}`}
      permission={payload.permission}
      reason={payload.reason}
      feature={payload.feature}
      fallbackOffered={payload.fallbackOffered}
      fallbackLabel={payload.fallbackLabel}
      {...rest}
    />
  );
}
