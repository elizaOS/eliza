/**
 * In-chat card the agent renders when an action needs an OS permission
 * (reminders, screen-recording, …): explains why, requests it through the
 * injected permissions registry, tracks the resulting state, and offers a
 * fallback or an open-settings path when the permission is denied. When no
 * registry is supplied it renders a passive not-determined state so it still
 * shows in stories/tests. Label copy and helpers live in
 * permission-card.helpers.
 */
import {
  type IPermissionsRegistry,
  openPermissionSettings,
  type PermissionId,
  type PermissionState,
} from "@elizaos/shared";
import type * as React from "react";
import { useCallback, useEffect, useState } from "react";

import { useBranding } from "../../../config/branding";
import { cn } from "../../../lib/utils";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import {
  defaultStateFor,
  getPermissionLabel,
  type PermissionCardFallbackChoice,
  type PermissionCardLabels,
  parseFeatureRef,
} from "./permission-card.helpers";

export interface PermissionCardProps {
  permission: PermissionId;
  reason: string;
  feature: string;
  fallbackOffered?: boolean;
  fallbackLabel?: string;
  /**
   * Permissions registry. When omitted, the card falls back to a passive
   * `not-determined` rendering so it still renders in stories/tests without
   * a wired runtime.
   */
  registry?: IPermissionsRegistry;
  /** Initial state override for tests / SSR. */
  initialState?: PermissionState;
  /** Called when the user dismisses the card. */
  onDismiss?: () => void;
  /** Called when the user picks the fallback option. */
  onFallback?: (choice: PermissionCardFallbackChoice) => void;
  /** Called once the registry reports `granted`. The agent uses this to
   *  retry the original action. */
  onGranted?: (state: PermissionState) => void;
  /** Opens OS settings for denied permissions that cannot be requested again. */
  onOpenSettings?: (permission: PermissionId) => void | Promise<void>;
  labels?: PermissionCardLabels;
  className?: string;
}

export function PermissionCard({
  permission,
  reason,
  feature,
  fallbackOffered = false,
  fallbackLabel,
  registry,
  initialState,
  onDismiss,
  onFallback,
  onGranted,
  onOpenSettings,
  labels = {},
  className,
}: PermissionCardProps): React.ReactElement | null {
  const { appName } = useBranding();
  const [state, setState] = useState<PermissionState>(
    initialState ?? registry?.get(permission) ?? defaultStateFor(permission),
  );
  const [requesting, setRequesting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const handleGrant = useCallback(async () => {
    if (!registry) return;
    setRequesting(true);
    try {
      const next = await registry.request(permission, {
        reason,
        feature: parseFeatureRef(feature),
      });
      setState(next);
      if (next.status === "granted") {
        onGranted?.(next);
      }
    } finally {
      setRequesting(false);
    }
  }, [registry, permission, reason, feature, onGranted]);

  const handleCheckAgain = useCallback(async () => {
    if (!registry) return;
    setChecking(true);
    try {
      const next = await registry.check(permission);
      setState(next);
      if (next.status === "granted") {
        onGranted?.(next);
      }
    } finally {
      setChecking(false);
    }
  }, [registry, permission, onGranted]);

  const handleOpenSettings = useCallback(() => {
    if (onOpenSettings) {
      void onOpenSettings(permission);
      return;
    }
    void openPermissionSettings(permission);
  }, [onOpenSettings, permission]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    onDismiss?.();
  }, [onDismiss]);

  const handleFallback = useCallback(() => {
    onFallback?.({ type: "use_fallback", feature, permission });
    setDismissed(true);
  }, [onFallback, feature, permission]);

  useEffect(() => {
    if (!registry) return;
    let cancelled = false;
    void registry
      .check(permission)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      // error-policy:J5 unhandled-rejection guard; the live permission state is
      // ALSO delivered by registry.subscribe below, so a transient initial-check
      // failure resolves as soon as the next subscription event arrives.
      .catch(() => {});
    const unsubscribe = registry.subscribe((states) => {
      const next = states.find((s) => s.id === permission);
      if (next) setState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [registry, permission]);

  if (dismissed) return null;

  // Defensive: agent shouldn't emit a card for already-granted permissions.
  if (state.status === "granted") {
    return (
      <Badge
        variant="outline"
        tone="success"
        data-testid="permission-card-granted"
        className={cn("mt-2", className)}
      >
        {labels.granted ?? "Access granted"} ✓
      </Badge>
    );
  }

  const isRestrictedEntitlement =
    state.status === "restricted" &&
    state.restrictedReason === "entitlement_required";

  const isRestrictedUnavailable =
    state.status === "restricted" && !isRestrictedEntitlement;

  const isLimited = state.status === "limited";

  const canOpenSettingsInstead =
    state.canRequest === false &&
    (state.status === "denied" ||
      state.status === "not-determined" ||
      isLimited);

  const title = getPermissionLabel(permission);
  const guidance = permissionGuidance(permission, state, appName);
  const resolvedFallbackLabel =
    fallbackLabel ??
    (permission === "reminders" ? "Use internal reminder" : "Use fallback");

  return (
    <Card
      variant="insetPadded"
      stack="compact"
      role="region"
      data-testid="permission-card"
      data-permission={permission}
      data-feature={feature}
      data-status={state.status}
      aria-label={`Permission request: ${title}`}
      className={cn("mt-2", className)}
    >
      <header className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-txt-strong">{title}</h3>
        <Badge variant="outline" size="compact" tone="muted">
          {statusLabel(state)}
        </Badge>
      </header>
      <p className="mb-3 text-sm leading-snug text-txt">{reason}</p>
      <div className="mb-3 text-xs leading-relaxed text-muted">
        <Card variant="insetCompact">
          <p className="font-medium text-txt">{guidance.primary}</p>
          <p className="mt-1">{guidance.secondary}</p>
        </Card>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isRestrictedEntitlement ? (
          <Button
            variant="default"
            size="sm"
            disabled
            data-testid="permission-card-primary"
            title="Coming soon: requires app entitlement."
          >
            {labels.comingSoon ?? "Coming soon: requires app entitlement"}
          </Button>
        ) : isRestrictedUnavailable || state.status === "not-applicable" ? (
          <Button
            variant="default"
            size="sm"
            disabled
            data-testid="permission-card-primary"
          >
            {labels.unavailable ?? "Unavailable on this platform"}
          </Button>
        ) : canOpenSettingsInstead ? (
          <Button
            variant="default"
            size="sm"
            onClick={handleOpenSettings}
            data-testid="permission-card-primary"
          >
            {labels.openSettings ?? "Open System Settings"}
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleGrant()}
            disabled={requesting || !registry}
            data-testid="permission-card-primary"
          >
            {requesting
              ? (labels.granting ?? "Requesting…")
              : isLimited
                ? (labels.upgradeAccess ?? "Upgrade access")
                : (labels.grantAccess ?? "Grant access")}
          </Button>
        )}
        {registry ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCheckAgain()}
            disabled={checking || requesting}
            data-testid="permission-card-check-again"
          >
            {checking ? "Checking…" : "Check again"}
          </Button>
        ) : null}
        {fallbackOffered ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleFallback}
            data-testid="permission-card-fallback"
          >
            {resolvedFallbackLabel}
          </Button>
        ) : null}
        <Button
          variant="mutedLink"
          size="content"
          onClick={handleDismiss}
          data-testid="permission-card-dismiss"
          className="ml-auto"
        >
          {labels.notNow ?? "Not now"}
        </Button>
      </div>
    </Card>
  );
}

function statusLabel(state: PermissionState): string {
  if (state.status === "not-determined") return "Not asked";
  if (state.status === "not-applicable") return "Unavailable";
  return state.status.replace(/-/g, " ");
}

function platformSettingsLabel(
  platform: PermissionState["platform"],
  appName: string,
): string {
  if (platform === "darwin") return "System Settings > Privacy & Security";
  if (platform === "ios") return `Settings > ${appName}`;
  if (platform === "android")
    return `Settings > Apps > ${appName} > Permissions`;
  if (platform === "win32") return "Windows privacy settings";
  if (platform === "linux") return "system privacy settings";
  return "browser settings";
}

function permissionGuidance(
  permission: PermissionId,
  state: PermissionState,
  appName: string,
): { primary: string; secondary: string } {
  const title = getPermissionLabel(permission);
  const settings = platformSettingsLabel(state.platform, appName);

  if (state.status === "limited") {
    if (permission === "calendar") {
      return {
        primary:
          "Apple Calendar has add-only access: new events can go to the default calendar.",
        secondary:
          "Existing calendars and events remain private. Upgrade to full access only if this feature must read, update, or delete them.",
      };
    }
    return {
      primary: `${title} has limited access.`,
      secondary: `Manage the allowed items in ${settings}, or upgrade access if this feature needs more.`,
    };
  }

  if (state.status === "denied" || state.canRequest === false) {
    return {
      primary: `Turn on ${title} in ${settings}.`,
      secondary:
        "After enabling it, return here and choose Check again. If you changed your mind, you can leave it off and use any offered fallback.",
    };
  }

  if (state.status === "restricted") {
    return {
      primary: `${title} is blocked by the current OS policy or app entitlement.`,
      secondary:
        "This device may need a different build, entitlement, profile, or administrator setting before the feature can work.",
    };
  }

  if (state.status === "not-applicable") {
    return {
      primary: `${title} is not available on this platform.`,
      secondary:
        "The agent can continue only if there is a fallback that does not use this device capability.",
    };
  }

  if (permission === "usage-access") {
    return {
      primary: `Open Android Usage Access and allow ${appName}.`,
      secondary:
        "This lets app blocking and Screen Time features read foreground app usage. Return here and choose Check again when done.",
    };
  }

  if (permission === "overlay") {
    return {
      primary: `Allow ${appName} to draw over other apps in Android settings.`,
      secondary:
        "The blocking screen needs this to appear above distracting apps. If you cancel, press Grant access again.",
    };
  }

  if (permission === "write-settings") {
    return {
      primary: `Open Android Write Settings and allow ${appName}.`,
      secondary:
        "Android requires this separate settings screen for brightness and device-setting changes.",
    };
  }

  return {
    primary: `When the OS prompt appears, choose Allow for ${title}.`,
    secondary: `If you cancel by accident, press Grant access again. If the OS stops prompting, open settings, enable it for ${appName}, then check again.`,
  };
}
