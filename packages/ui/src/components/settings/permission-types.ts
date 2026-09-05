/**
 * Projects the shared permission catalog into UI display applicability and
 * translation keys, alongside permission status and capability presentation.
 */

import {
  type PermissionId,
  type PermissionPlatformProjection,
  type PermissionStatus,
  type Platform,
  projectPermissionDefinitions,
} from "@elizaos/shared";
import type { CapabilityTone } from "../capabilities/connected-capability-presentation";

/** Permission definition enriched only with UI translation keys. */
export interface PermissionDef {
  readonly id: PermissionId;
  readonly name: string;
  readonly nameKey: string;
  readonly description: string;
  readonly descriptionKey: string;
  readonly icon: string;
  readonly platforms: readonly Platform[];
  readonly requiredForFeatures: readonly string[];
}

const DESKTOP = ["darwin", "win32", "linux"] as const;
const MOBILE_AND_WEB = ["ios", "android", "web"] as const;
const ALL_PLATFORMS = [...DESKTOP, ...MOBILE_AND_WEB] as const;
const APPLE_MOBILE = ["ios"] as const;
const MOBILE = ["ios", "android"] as const;
const ANDROID = ["android"] as const;
const MACOS = ["darwin"] as const;

/** Platforms on which settings intentionally present each permission. */
export const UI_PERMISSION_DISPLAY_PLATFORMS = {
  accessibility: MACOS,
  "screen-recording": ["darwin", ...MOBILE_AND_WEB],
  microphone: DESKTOP,
  camera: ALL_PLATFORMS,
  shell: ALL_PLATFORMS,
  "website-blocking": ALL_PLATFORMS,
  location: DESKTOP,
  reminders: MACOS,
  calendar: ["darwin", ...APPLE_MOBILE],
  health: ["darwin", ...MOBILE],
  screentime: ["darwin", ...MOBILE],
  contacts: ["darwin", ...MOBILE],
  notes: MACOS,
  notifications: ALL_PLATFORMS,
  "full-disk": MACOS,
  automation: MACOS,
  "speech-recognition": ["ios", "web"],
  photos: MOBILE_AND_WEB,
  phone: ANDROID,
  messages: ANDROID,
  wifi: ANDROID,
  bluetooth: MOBILE,
  "app-blocking": MOBILE,
  "usage-access": ANDROID,
  overlay: ANDROID,
  "write-settings": ANDROID,
  "local-network": MOBILE,
  "battery-optimization": ANDROID,
} as const satisfies PermissionPlatformProjection;

function translationSegment(id: PermissionId): string {
  return id.replace(/-([a-z])/gu, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

export const SYSTEM_PERMISSIONS: readonly PermissionDef[] =
  projectPermissionDefinitions(UI_PERMISSION_DISPLAY_PLATFORMS).map(
    (definition) => {
      const segment = translationSegment(definition.id);
      return {
        ...definition,
        nameKey: `permissionssection.permission.${segment}.name`,
        descriptionKey: `permissionssection.permission.${segment}.description`,
      };
    },
  );

/** Capability toggle definition. */
export interface CapabilityDef {
  id: string;
  label: string;
  labelKey: string;
  description: string;
  descriptionKey: string;
  requiredPermissions: PermissionId[];
}

export const CAPABILITIES: CapabilityDef[] = [
  {
    id: "browser",
    label: "Browser Control",
    labelKey: "permissionssection.capability.browser.label",
    description: "Automated web browsing and interaction",
    descriptionKey: "permissionssection.capability.browser.description",
    requiredPermissions: ["accessibility"],
  },
  {
    id: "computeruse",
    label: "Computer Use",
    labelKey: "permissionssection.capability.computerUse.label",
    description: "Full desktop control with mouse and keyboard",
    descriptionKey: "permissionssection.capability.computerUse.description",
    requiredPermissions: ["accessibility", "screen-recording"],
  },
  {
    id: "vision",
    label: "Vision",
    labelKey: "permissionssection.capability.vision.label",
    description: "Screen capture and visual analysis",
    descriptionKey: "permissionssection.capability.vision.description",
    requiredPermissions: ["screen-recording"],
  },
  {
    id: "coding-agent",
    label: "Task Agent Swarms",
    labelKey: "permissionssection.capability.codingAgent.label",
    description:
      "Orchestrate open-ended CLI task agents (Claude Code, Gemini CLI, Codex, Aider, Pi)",
    descriptionKey: "permissionssection.capability.codingAgent.description",
    requiredPermissions: [],
  },
];

export const PERMISSION_BADGE_LABELS: Record<
  PermissionStatus,
  {
    defaultLabel: string;
    labelKey: string;
    tone: CapabilityTone;
  }
> = {
  granted: {
    tone: "success",
    labelKey: "permissionssection.badge.granted",
    defaultLabel: "Granted",
  },
  limited: {
    tone: "warning",
    labelKey: "permissionssection.badge.limited",
    defaultLabel: "Limited",
  },
  denied: {
    tone: "danger",
    labelKey: "permissionssection.badge.denied",
    defaultLabel: "Denied",
  },
  "not-determined": {
    tone: "warning",
    labelKey: "permissionssection.badge.notDetermined",
    defaultLabel: "Not Set",
  },
  restricted: {
    tone: "muted",
    labelKey: "permissionssection.badge.restricted",
    defaultLabel: "Restricted",
  },
  "not-applicable": {
    tone: "muted",
    labelKey: "permissionssection.badge.notApplicable",
    defaultLabel: "N/A",
  },
};

/** Reusable settings-panel Tailwind class names. */
export const SETTINGS_PANEL_CLASSNAME =
  "rounded border border-border/60 bg-bg/40 p-4 space-y-4";
export const SETTINGS_PANEL_HEADER_CLASSNAME =
  "flex flex-wrap items-start justify-between gap-3";
export const SETTINGS_PANEL_ACTIONS_CLASSNAME = "flex items-center gap-2";

export const SETTINGS_REFRESH_DELAYS_MS = [1500, 4000] as const;

export function translateWithFallback(
  t: (key: string) => string,
  key: string,
  fallback: string,
): string {
  const value = t(key);
  return !value || value === key ? fallback : value;
}

export function getPermissionAction(
  t: (key: string) => string,
  id: PermissionId,
  status: PermissionStatus,
  canRequest: boolean,
  platform?: string,
): {
  ariaLabelPrefix: string;
  label: string;
  type: "request" | "settings";
} | null {
  if (status === "not-applicable") {
    return null;
  }

  if (status === "limited") {
    const label = canRequest
      ? translateWithFallback(
          t,
          "permissionssection.UpgradeAccess",
          "Upgrade access",
        )
      : translateWithFallback(t, "permissionssection.Manage", "Manage");
    return {
      ariaLabelPrefix: label,
      label,
      type: canRequest ? "request" : "settings",
    };
  }

  if (status === "granted" && id !== "shell") {
    const label = translateWithFallback(
      t,
      "permissionssection.Manage",
      "Manage",
    );
    return {
      ariaLabelPrefix: label,
      label,
      type: "settings",
    };
  }

  const usesWindowsPrivacySettings =
    platform === "win32" &&
    (id === "microphone" ||
      id === "camera" ||
      id === "location" ||
      id === "notifications");

  if (status === "not-determined" && canRequest) {
    if (id === "website-blocking") {
      const label =
        platform === "ios"
          ? translateWithFallback(
              t,
              "permissionssection.OpenSettings",
              "Open Settings",
            )
          : translateWithFallback(
              t,
              "permissionssection.RequestApproval",
              "Request Approval",
            );
      return {
        ariaLabelPrefix: label,
        label,
        type: "request",
      };
    }

    const label = usesWindowsPrivacySettings
      ? translateWithFallback(
          t,
          "permissionssection.OpenPrivacySettings",
          "Open Privacy Settings",
        )
      : id === "camera"
        ? translateWithFallback(
            t,
            "permissionssection.CheckAccess",
            "Check Access",
          )
        : translateWithFallback(t, "permissionssection.Grant", "Grant");
    return {
      ariaLabelPrefix: label,
      label,
      type: usesWindowsPrivacySettings ? "settings" : "request",
    };
  }

  if (id === "website-blocking") {
    const label =
      platform === "ios"
        ? translateWithFallback(
            t,
            "permissionssection.OpenSettings",
            "Open Settings",
          )
        : translateWithFallback(
            t,
            "permissionssection.OpenHostsFile",
            "Open Hosts File",
          );
    return {
      ariaLabelPrefix: label,
      label,
      type: "settings",
    };
  }

  const label = translateWithFallback(
    t,
    "permissionssection.OpenSettings",
    "Open Settings",
  );
  return {
    ariaLabelPrefix: label,
    label,
    type: "settings",
  };
}

export function getPermissionBadge(
  t: (key: string) => string,
  id: PermissionId,
  status: PermissionStatus,
  platform: string,
): { tone: CapabilityTone; label: string } {
  if (status === "denied") {
    if (id === "shell") {
      return {
        tone: "danger",
        label: translateWithFallback(t, "permissionssection.badge.off", "Off"),
      };
    }

    if (id === "website-blocking") {
      return {
        tone: "danger",
        label: translateWithFallback(
          t,
          "permissionssection.badge.needsAdmin",
          "Needs Admin",
        ),
      };
    }

    if (platform === "darwin") {
      return {
        tone: "danger",
        label: translateWithFallback(
          t,
          "permissionssection.badge.offInSettings",
          "Off in Settings",
        ),
      };
    }
  }

  if (status === "not-determined") {
    if (id === "website-blocking") {
      return {
        tone: "warning",
        label: translateWithFallback(
          t,
          "permissionssection.badge.needsApproval",
          "Needs Approval",
        ),
      };
    }

    return {
      tone: "warning",
      label: translateWithFallback(
        t,
        "permissionssection.badge.notAsked",
        "Not Asked",
      ),
    };
  }

  const badge = PERMISSION_BADGE_LABELS[status];
  return {
    tone: badge.tone,
    label: translateWithFallback(t, badge.labelKey, badge.defaultLabel),
  };
}
