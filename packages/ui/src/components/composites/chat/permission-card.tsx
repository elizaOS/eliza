import {
  type IPermissionsRegistry,
  isPermissionId,
  openPermissionSettings,
  type PermissionId,
  type PermissionState,
} from "@elizaos/shared";
import type * as React from "react";
import { useCallback, useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";

/**
 * Friendly human-readable labels per permission id. Used as the card title
 * (e.g. `reminders` → "Apple Reminders").
 */
export const PERMISSION_LABELS: Record<PermissionId, string> = {
  accessibility: "Accessibility",
  "screen-recording": "Screen Recording",
  microphone: "Microphone",
  camera: "Camera",
  shell: "Shell",
  "website-blocking": "Website Blocking",
  location: "Location",
  reminders: "Apple Reminders",
  calendar: "Apple Calendar",
  health: "Apple Health",
  screentime: "Screen Time",
  contacts: "Contacts",
  notes: "Apple Notes",
  notifications: "Notifications",
  "full-disk": "Full Disk Access",
  automation: "Automation",
};

export function getPermissionLabel(id: PermissionId): string {
  return PERMISSION_LABELS[id] ?? id;
}

/**
 * Result emitted to the agent when the user picks the fallback option. The
 * chat host turns this into a system-tagged user message:
 *   `__permission_card__:use_fallback feature=<feature>`
 *
 * The agent's lifeops fallback flow already recognises this prefix; see the
 * `system-prompt-action-block.md` doc and the lifeops permission router. We
 * chose a system-tagged message (vs a custom WS event) so it goes through
 * the existing planner pipeline and lands in the trajectory log without any
 * out-of-band wiring.
 */
export interface PermissionCardFallbackChoice {
  type: "use_fallback";
  feature: string;
  permission: PermissionId;
}

export interface PermissionCardLabels {
  grantAccess?: string;
  openSettings?: string;
  notNow?: string;
  comingSoon?: string;
  granted?: string;
  granting?: string;
}

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
  labels?: PermissionCardLabels;
  className?: string;
}

function defaultStateFor(id: PermissionId): PermissionState {
  const platform =
    typeof navigator !== "undefined" &&
    /Win/i.test(navigator.platform ?? "")
      ? "win32"
      : typeof navigator !== "undefined" &&
          /Linux/i.test(navigator.platform ?? "")
        ? "linux"
        : "darwin";
  return {
    id,
    status: "not-determined",
    lastChecked: 0,
    canRequest: true,
    platform,
  };
}

function parseFeatureRef(feature: string): { app: string; action: string } {
  // Wire format is `<app>.<area>.<action>` — collapse area+action into the
  // registry's `{ app, action }` ref.
  const parts = feature.split(".");
  const app = parts[0] ?? "unknown";
  const action = parts.slice(1).join(".") || "unknown";
  return { app, action };
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
    void openPermissionSettings(permission);
  }, [permission]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    onDismiss?.();
  }, [onDismiss]);

  const handleFallback = useCallback(() => {
    onFallback?.({ type: "use_fallback", feature, permission });
    setDismissed(true);
  }, [onFallback, feature, permission]);

  if (dismissed) return null;

  // Defensive: agent shouldn't emit a card for already-granted permissions.
  if (state.status === "granted") {
    return (
      <div
        data-testid="permission-card-granted"
        className={cn(
          "mt-2 inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2 py-1 text-xs font-medium text-success",
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

  const isDeniedNoRequest =
    state.status === "denied" && state.canRequest === false;

  const title = getPermissionLabel(permission);

  return (
    <section
      data-testid="permission-card"
      data-permission={permission}
      data-feature={feature}
      data-status={state.status}
      aria-label={`Permission request: ${title}`}
      className={cn(
        "mt-2 rounded-lg border border-border/40 bg-bg-accent/60 p-3",
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
        ) : isDeniedNoRequest ? (
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
        {fallbackOffered && fallbackLabel ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleFallback}
            data-testid="permission-card-fallback"
          >
            {fallbackLabel}
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

/**
 * Render-helper invoked by the chat transcript's `renderMessageContent` hook
 * when the message text contains a parsed permission_request block. The host
 * passes the parsed payload, the registry, and message-level callbacks.
 */
export interface PermissionCardPayload {
  permission: string;
  reason: string;
  feature: string;
  fallbackOffered?: boolean;
  fallbackLabel?: string;
}

/**
 * Minimal UI-side parser for `permission_request` action blocks. Mirrors the
 * server-side `parseActionBlock` output for `permission_request` so the
 * chat surface can render the inline card without pulling in `@elizaos/agent`.
 *
 * Returns `null` for any other action block (`respond`, `escalate`,
 * `ignore`, `complete`) so the caller can fall back to plain text rendering.
 */
export function parsePermissionRequestFromText(text: string): {
  display: string;
  payload: PermissionCardPayload;
} | null {
  if (!text) return null;
  const safeText = text.length > 100_000 ? text.slice(0, 100_000) : text;
  const fenced = safeText.match(
    /```(?:json)?\s{0,32}\n?(\{[\s\S]{0,50000}?\})\s{0,32}\n?```/,
  );
  let jsonStr: string | undefined = fenced?.[1];
  let display = safeText;
  if (fenced) {
    display = safeText.replace(fenced[0], "").trim();
  } else {
    const lastBrace = safeText.lastIndexOf("{");
    if (lastBrace < 0) return null;
    jsonStr = safeText.slice(lastBrace);
    display = safeText.slice(0, lastBrace).trim();
  }
  if (!jsonStr) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { action?: unknown }).action !== "permission_request"
  ) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const permission = record.permission;
  const reason = record.reason;
  const feature = record.feature;
  if (
    !isPermissionId(permission) ||
    typeof reason !== "string" ||
    typeof feature !== "string"
  ) {
    return null;
  }
  const payload: PermissionCardPayload = {
    permission,
    reason,
    feature,
    fallbackOffered: record.fallback_offered === true,
    ...(typeof record.fallback_label === "string" &&
    record.fallback_label.length > 0
      ? { fallbackLabel: record.fallback_label }
      : {}),
  };
  return { display, payload };
}

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
