export type {
  PermissionCheckResult,
  PermissionState,
  PermissionStatus,
  Platform,
  SystemPermissionDefinition,
  SystemPermissionId,
} from "@elizaos/shared";

import type {
  PermissionState,
  Platform,
  SystemPermissionDefinition,
  SystemPermissionId,
} from "@elizaos/shared";

/** Local variant uses an index signature (the canonical contract uses explicit keys). */
export interface AllPermissionsState {
  [key: string]: PermissionState;
}

export const SYSTEM_PERMISSIONS: SystemPermissionDefinition[] = [
  {
    id: "accessibility",
    name: "Accessibility",
    description:
      "Control mouse, keyboard, and interact with other applications",
    icon: "cursor",
    platforms: ["darwin"],
    requiredForFeatures: ["computeruse", "browser"],
  },
  {
    id: "screen-recording",
    name: "Screen Recording",
    description: "Capture screen content for screenshots and vision",
    icon: "monitor",
    platforms: ["darwin"],
    requiredForFeatures: ["computeruse", "vision"],
  },
  {
    id: "microphone",
    name: "Microphone",
    description: "Voice input for talk mode and speech recognition",
    icon: "mic",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["talkmode", "voice"],
  },
  {
    id: "camera",
    name: "Camera",
    description: "Video input for vision and video capture",
    icon: "camera",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["camera", "vision"],
  },
  {
    id: "shell",
    name: "Shell Access",
    description: "Execute terminal commands and scripts",
    icon: "terminal",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["shell"],
  },
  {
    id: "website-blocking",
    name: "Website Blocking",
    description:
      "Edit the system hosts file to block distracting websites. This may require admin/root approval each time.",
    icon: "shield-ban",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["website-blocker"],
  },
];

const PERMISSION_MAP = new Map<SystemPermissionId, SystemPermissionDefinition>(
  SYSTEM_PERMISSIONS.map((p) => [p.id, p]),
);

export function isPermissionApplicable(
  id: SystemPermissionId,
  platform: Platform,
): boolean {
  const def = PERMISSION_MAP.get(id);
  return def ? def.platforms.includes(platform) : false;
}
