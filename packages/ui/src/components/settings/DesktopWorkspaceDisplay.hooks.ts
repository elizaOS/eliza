/**
 * Formats a DesktopWorkspaceSnapshot into the multi-line diagnostics blob shown
 * by DesktopWorkspaceDisplay — one line per display, plus power/idle, primary
 * display, clipboard formats, and resolved paths. `useDesktopDiagnosticsText`
 * memoizes the render.
 */

import { useMemo } from "react";
import type { TranslateFn } from "../../types";
import {
  type DesktopWorkspaceSnapshot,
  formatDesktopWorkspaceSummary,
} from "../../utils/desktop-workspace";

function buildDiagnosticsText(
  snapshot: DesktopWorkspaceSnapshot | null,
  t: TranslateFn,
): string {
  if (!snapshot) {
    return t("desktopworkspacesection.DesktopDiagnosticsUnavailable");
  }

  const displayLines =
    snapshot.displays.length > 0
      ? snapshot.displays.map(
          (display) =>
            `display:${display.id} ${display.bounds.width}x${display.bounds.height} @ ${display.bounds.x},${display.bounds.y}${display.isPrimary ? " primary" : ""}`,
        )
      : ["display:none"];

  return [
    formatDesktopWorkspaceSummary(snapshot),
    snapshot.power
      ? `power:${snapshot.power.onBattery ? "battery" : "ac"} idle=${snapshot.power.idleState} idleTime=${snapshot.power.idleTime}s`
      : "power:unavailable",
    snapshot.primaryDisplay
      ? `primary:${snapshot.primaryDisplay.bounds.width}x${snapshot.primaryDisplay.bounds.height}`
      : "primary:unavailable",
    snapshot.clipboard
      ? `clipboard:${snapshot.clipboard.formats.join(", ") || "plain-text"}`
      : "clipboard:unavailable",
    ...displayLines,
    ...Object.entries(snapshot.paths).map(([name, path]) => `${name}:${path}`),
  ].join("\n");
}

export function useDesktopDiagnosticsText(
  snapshot: DesktopWorkspaceSnapshot | null,
  t: TranslateFn,
): string {
  return useMemo(() => buildDiagnosticsText(snapshot, t), [snapshot, t]);
}
