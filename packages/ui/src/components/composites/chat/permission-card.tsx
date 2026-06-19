import {
  type IPermissionsRegistry,
  openPermissionSettings,
  type PermissionId,
  type PermissionState,
} from "@elizaos/shared";
import type * as React from "react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
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
  const [state, setState] = useState<PermissionState>(
    initialState ?? registry?.get(permission) ?? defaultStateFor(permission),
  );
  const [requesting, setRequesting] = useState(false);
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
      <div
        data-testid="permission-card-granted"
        className={cn(
          "mt-2 inline-flex items-center gap-1.5 rounded-sm border border-success/30 bg-success/10 px-2 py-1 text-xs font-medium text-success",
          className,
        )}
      >
        {labels.granted ?? "Access granted"} ✓
      </div>
    );
  }

  const isRestrictedEntitlement =
    state.status === "restricted" &&
    state.restrictedReason === "entitlement_required";

  const isRestrictedUnavailable =
    state.status === "restricted" && !isRestrictedEntitlement;

  const canOpenSettingsInstead =
    state.canRequest === false &&
    (state.status === "denied" || state.status === "not-determined");

  const title = getPermissionLabel(permission);
  const resolvedFallbackLabel =
    fallbackLabel ??
    (permission === "reminders" ? "Use internal reminder" : "Use fallback");

  return (
    <section
      data-testid="permission-card"
      data-permission={permission}
      data-feature={feature}
      data-status={state.status}
      aria-label={`Permission request: ${title}`}
      className={cn(
        "mt-2 rounded-sm border border-border/40 bg-bg-accent/60 p-3",
        className,
      )}
    >
      <header className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-txt-strong">{title}</h3>
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
          Permission
        </span>
      </header>
      <p className="mb-3 text-sm leading-snug text-txt">{reason}</p>
      <div className="flex flex-wrap items-center gap-2">
        {isRestrictedEntitlement ? (
          <Button
            variant="default"
            size="sm"
            disabled
            data-testid="permission-card-primary"
            title="Coming soon — requires app entitlement."
          >
            {labels.comingSoon ?? "Coming soon — requires app entitlement"}
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
              : (labels.grantAccess ?? "Grant access")}
          </Button>
        )}
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
        <button
          type="button"
          onClick={handleDismiss}
          data-testid="permission-card-dismiss"
          className="ml-auto text-xs text-muted hover:text-txt-strong"
        >
          {labels.notNow ?? "Not now"}
        </button>
      </div>
    </section>
  );
}
