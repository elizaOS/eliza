import type { PermissionId, PermissionStatus } from "../../api";

/** Permission definition for UI rendering. */
export interface PermissionDef {
  id: PermissionId;
  name: string;
  nameKey: string;
  description: string;
  descriptionKey: string;
  icon: string;
  platforms: string[];
  requiredForFeatures: string[];
}

export const SYSTEM_PERMISSIONS: PermissionDef[] = [
  {
    id: "accessibility",
    name: "Accessibility",
    nameKey: "permissionssection.permission.accessibility.name",
    description:
      "Control mouse, keyboard, and interact with other applications",
    descriptionKey: "permissionssection.permission.accessibility.description",
    icon: "cursor",
    platforms: ["darwin"],
    requiredForFeatures: ["computeruse", "browser"],
  },
  {
    id: "screen-recording",
    name: "Screen Recording",
    nameKey: "permissionssection.permission.screenRecording.name",
    description: "Capture screen content for screenshots and vision",
    descriptionKey: "permissionssection.permission.screenRecording.description",
    icon: "monitor",
    platforms: ["darwin"],
    requiredForFeatures: ["computeruse", "vision"],
  },
  {
    id: "microphone",
    name: "Microphone",
    nameKey: "permissionssection.permission.microphone.name",
    description: "Voice input for talk mode and speech recognition",
    descriptionKey: "permissionssection.permission.microphone.description",
    icon: "mic",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["talkmode", "voice"],
  },
  {
    id: "camera",
    name: "Camera",
    nameKey: "permissionssection.permission.camera.name",
    description: "Video input for vision and video capture",
    descriptionKey: "permissionssection.permission.camera.description",
    icon: "camera",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["camera", "vision"],
  },
  {
    id: "shell",
    name: "Shell Access",
    nameKey: "permissionssection.permission.shell.name",
    description: "Execute terminal commands and scripts",
    descriptionKey: "permissionssection.permission.shell.description",
    icon: "terminal",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["shell"],
  },
  {
    id: "website-blocking",
    name: "Website Blocking",
    nameKey: "permissionssection.permission.websiteBlocking.name",
    description:
      "Edit the system hosts file to block distracting websites. This may require admin/root approval each time.",
    descriptionKey: "permissionssection.permission.websiteBlocking.description",
    icon: "shield-ban",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["website-blocker"],
  },
  {
    id: "location",
    name: "Location",
    nameKey: "permissionssection.permission.location.name",
    description:
      "Read the device's current location for travel-time, time-zone, and place-aware planning. Mobile uses GPS; desktop falls back to coarse IP geolocation.",
    descriptionKey: "permissionssection.permission.location.description",
    icon: "map-pin",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["travel-time", "location"],
  },
  {
    id: "reminders",
    name: "Apple Reminders",
    nameKey: "permissionssection.permission.reminders.name",
    description: "Create and read reminders for LifeOps tasks and follow-ups",
    descriptionKey: "permissionssection.permission.reminders.description",
    icon: "list-todo",
    platforms: ["darwin"],
    requiredForFeatures: ["lifeops", "reminders"],
  },
  {
    id: "calendar",
    name: "Apple Calendar",
    nameKey: "permissionssection.permission.calendar.name",
    description: "Read and write calendar events for scheduling",
    descriptionKey: "permissionssection.permission.calendar.description",
    icon: "calendar",
    platforms: ["darwin"],
    requiredForFeatures: ["lifeops", "calendar"],
  },
  {
    id: "health",
    name: "Apple Health",
    nameKey: "permissionssection.permission.health.name",
    description: "Read HealthKit data, including sleep from paired devices",
    descriptionKey: "permissionssection.permission.health.description",
    icon: "heart-pulse",
    platforms: ["darwin"],
    requiredForFeatures: ["lifeops", "health", "sleep"],
  },
  {
    id: "screentime",
    name: "Screen Time",
    nameKey: "permissionssection.permission.screentime.name",
    description: "Read app and device usage signals for LifeOps",
    descriptionKey: "permissionssection.permission.screentime.description",
    icon: "hourglass",
    platforms: ["darwin"],
    requiredForFeatures: ["lifeops", "screentime"],
  },
  {
    id: "contacts",
    name: "Contacts",
    nameKey: "permissionssection.permission.contacts.name",
    description: "Read contacts for person-aware reminders and follow-ups",
    descriptionKey: "permissionssection.permission.contacts.description",
    icon: "contact",
    platforms: ["darwin"],
    requiredForFeatures: ["lifeops", "contacts"],
  },
  {
    id: "notes",
    name: "Apple Notes",
    nameKey: "permissionssection.permission.notes.name",
    description: "Read and create notes through user-approved automation",
    descriptionKey: "permissionssection.permission.notes.description",
    icon: "notebook-tabs",
    platforms: ["darwin"],
    requiredForFeatures: ["lifeops", "notes"],
  },
  {
    id: "notifications",
    name: "Notifications",
    nameKey: "permissionssection.permission.notifications.name",
    description:
      "Show system notifications for reminders and background results",
    descriptionKey: "permissionssection.permission.notifications.description",
    icon: "bell",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["notifications", "lifeops"],
  },
  {
    id: "full-disk",
    name: "Full Disk Access",
    nameKey: "permissionssection.permission.fullDisk.name",
    description: "Read protected local app data when explicitly enabled",
    descriptionKey: "permissionssection.permission.fullDisk.description",
    icon: "hard-drive",
    platforms: ["darwin"],
    requiredForFeatures: ["imessage", "local-data"],
  },
  {
    id: "automation",
    name: "Automation",
    nameKey: "permissionssection.permission.automation.name",
    description: "Control other macOS apps through Apple Events",
    descriptionKey: "permissionssection.permission.automation.description",
    icon: "workflow",
    platforms: ["darwin"],
    requiredForFeatures: ["lifeops", "automation"],
  },
];

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
    tone: "success" | "danger" | "warning" | "muted";
  }
> = {
  granted: {
    tone: "success",
    labelKey: "permissionssection.badge.granted",
    defaultLabel: "Granted",
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
  "rounded-2xl border border-border/60 bg-bg/40 p-4 space-y-4";
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
  if (status === "granted" || status === "not-applicable") {
    return null;
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
): { tone: "success" | "danger" | "warning" | "muted"; label: string } {
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
