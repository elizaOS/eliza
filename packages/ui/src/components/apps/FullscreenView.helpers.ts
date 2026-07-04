/**
 * Static audit manifest of the desktop-only click targets in the game view
 * (native window refresh, focus, ...), consumed by the desktop-workspace click
 * audit to assert each expected native action has coverage.
 */

import type { DesktopClickAuditItem } from "../../utils/desktop-workspace";

export const DESKTOP_GAME_CLICK_AUDIT: readonly DesktopClickAuditItem[] = [
  {
    id: "game-native-refresh",
    entryPoint: "game",
    label: "Refresh Native Window State",
    expectedAction: "Refresh canvas bounds and GPU window state.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-native-focus",
    entryPoint: "game",
    label: "Focus Game Window",
    expectedAction: "Focus the native game canvas window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-native-visibility",
    entryPoint: "game",
    label: "Show/Hide Game Window",
    expectedAction: "Show or hide the native game canvas window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-native-always-on-top",
    entryPoint: "game",
    label: "Toggle Game Window Always On Top",
    expectedAction:
      "Toggle whether the native game window floats above other windows.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-native-snapshot",
    entryPoint: "game",
    label: "Snapshot Game Window",
    expectedAction: "Capture a native snapshot of the game canvas window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "game-gpu-window",
    entryPoint: "game",
    label: "Launch GPU Diagnostics",
    expectedAction: "Create or focus a safe GPU diagnostics window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
] as const;
