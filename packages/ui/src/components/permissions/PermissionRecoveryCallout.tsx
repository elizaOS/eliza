/**
 * Presents recoverable permission denials, request failures, and refresh
 * failures with Retry and an OS Settings handoff.
 * A caller-supplied opener takes precedence so desktop controllers can cross
 * their native RPC boundary; otherwise Capacitor uses its native plugin and
 * web-flavored surfaces use the shared platform deep-link.
 */
import { Capacitor } from "@capacitor/core";
import type { PermissionId } from "@elizaos/shared/contracts/permissions";
import { openPermissionSettings } from "@elizaos/shared/utils/permission-deep-links";
import { useState } from "react";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { cn } from "../../lib/utils";
import { openMobilePermissionSettings } from "../../platform/mobile-permissions-client";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";

export interface PermissionRecoveryCalloutProps {
  permission: PermissionId;
  title: string;
  description: string;
  retryLabel?: string;
  settingsLabel?: string;
  settingsErrorLabel?: string;
  openingLabel?: string;
  checkingLabel?: string;
  onOpenSettings?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
  className?: string;
  testId?: string;
}

function isNativeMobileRuntime(): boolean {
  try {
    return Capacitor.isNativePlatform() && !isElectrobunRuntime();
  } catch {
    // error-policy:J4 capability probe — no Capacitor runtime means the
    // web-flavored recovery copy is shown.
    return false;
  }
}

export function PermissionRecoveryCallout({
  permission,
  title,
  description,
  retryLabel = "Try again",
  settingsLabel = "Open Settings",
  settingsErrorLabel = "Couldn’t open Settings. Open System Settings manually, then re-check.",
  openingLabel = "Opening…",
  checkingLabel = "Checking…",
  onOpenSettings,
  onRetry,
  className,
  testId = "permission-recovery-callout",
}: PermissionRecoveryCalloutProps): React.JSX.Element {
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const handleOpenSettings = async () => {
    setOpening(true);
    setOpenError(false);
    try {
      if (onOpenSettings) {
        await onOpenSettings();
      } else if (isNativeMobileRuntime()) {
        await openMobilePermissionSettings(permission);
      } else {
        await openPermissionSettings(permission);
      }
    } catch {
      // error-policy:J4 a failed OS handoff stays visible so recovery never
      // looks successful when System Settings did not open.
      setOpenError(true);
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
    <Alert
      variant="warningStrong"
      data-testid={testId}
      className={cn("p-3 text-left", className)}
    >
      <div className="text-sm font-semibold text-txt-strong">{title}</div>
      <p className="mt-1 text-sm leading-snug text-txt">{description}</p>
      {openError ? (
        <p
          className="mt-2 text-sm leading-snug text-danger"
          data-testid={`${testId}-settings-error`}
        >
          {settingsErrorLabel}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={() => void handleOpenSettings()}
          disabled={opening}
          data-testid={`${testId}-settings`}
        >
          {opening ? openingLabel : settingsLabel}
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
            {retrying ? checkingLabel : retryLabel}
          </Button>
        ) : null}
      </div>
    </Alert>
  );
}
