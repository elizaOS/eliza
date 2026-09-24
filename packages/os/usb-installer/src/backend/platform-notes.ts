import type { PlatformId } from "./types";

export interface PlatformNote {
  platform: PlatformId;
  title: string;
  notes: string[];
}

export const PLATFORM_NOTES: PlatformNote[] = [
  {
    platform: "darwin",
    title: "macOS",
    notes: [
      "Enumerate disks with diskutil list -plist and diskutil info -plist.",
      "Unmount the selected disk before raw writes.",
      "Privileged writes should go through a signed helper, not renderer code.",
    ],
  },
  {
    platform: "linux",
    title: "Linux",
    notes: [
      "Enumerate block devices with lsblk --json --bytes --paths.",
      "Reject devices with mountpoints unless the user explicitly unmounts them.",
      "Privileged writes should use pkexec, udisks2, or a small audited helper.",
    ],
  },
  {
    platform: "win32",
    title: "Windows",
    notes: [
      "Enumerate removable disks through PowerShell Get-Disk/Get-Volume or SetupAPI.",
      "Require physical-drive identity confirmation before write access.",
      "Privileged writes should run in a signed elevated helper process.",
    ],
  },
];

export function detectPlatformId(
  platform = globalThis.process?.platform,
): PlatformId {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  return "unknown";
}
