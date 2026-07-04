/**
 * Alert callout shown when a permission is denied — offers Retry (`onRetry`) and
 * an "Open Settings" affordance that deep-links to the OS permission screen.
 * Routes to the native mobile deep-link on Capacitor (non-Electrobun) and the
 * shared web/desktop deep-link elsewhere. Consumed by the permission-priming
 * modal and permission settings rows.
 */
import { Capacitor } from "@capacitor/core";
import type { PermissionId } from "@elizaos/shared/contracts/permissions";
import { openPermissionSettings } from "@elizaos/shared/utils/permission-deep-links";
import { useState } from "react";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { cn } from "../../lib/utils";
import { openMobilePermissionSettings } from "../../platform/mobile-permissions-client";
import { Button } from "../ui/button";

export interface PermissionRecoveryCalloutProps {
  permission: PermissionId;
  title: string;
  description: string;
  retryLabel?: string;
  settingsLabel?: string;
  onRetry?: () => void | Promise<void>;
  className?: string;
  testId?: string;
}

function isNativeMobileRuntime(): boolean {
  try {
    return Capacitor.isNativePlatform() && !isElectrobunRuntime();
  } catch {
    return false;
  }
}

export function PermissionRecoveryCallout({
  permission,
  title,
  description,
  retryLabel = "Try again",
  settingsLabel = "Open Settings",
  onRetry,
  className,
  testId = "permission-recovery-callout",
}: PermissionRecoveryCalloutProps): React.JSX.Element {
  const [opening, setOpening] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const handleOpenSettings = async () => {
    setOpening(true);
    try {
      if (isNativeMobileRuntime()) {
        await openMobilePermissionSettings(permission);
      } else {
        await openPermissionSettings(permission);
      }
    } finally {
      setOpening(false);
    }
  };

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn(
        "rounded-sm border border-warn/30 bg-warn/10 p-3 text-left",
        className,
      )}
    >
      <div className="text-sm font-semibold text-txt-strong">{title}</div>
      <p className="mt-1 text-sm leading-snug text-txt">{description}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={() => void handleOpenSettings()}
          disabled={opening}
          data-testid={`${testId}-settings`}
        >
          {opening ? "Opening..." : settingsLabel}
        </Button>
        {onRetry ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleRetry()}
            disabled={retrying}
            data-testid={`${testId}-retry`}
          >
            {retrying ? "Checking..." : retryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
