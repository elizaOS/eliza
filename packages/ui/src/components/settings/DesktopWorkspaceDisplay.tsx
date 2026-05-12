import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { useMemo } from "react";
import {
  type DesktopWorkspaceSnapshot,
  formatDesktopWorkspaceSummary,
} from "../../utils/desktop-workspace";

type Translator = (key: string, options?: Record<string, unknown>) => string;

function buildDiagnosticsText(
  snapshot: DesktopWorkspaceSnapshot | null,
  t: Translator,
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
  t: Translator,
): string {
  return useMemo(() => buildDiagnosticsText(snapshot, t), [snapshot, t]);
}

export function DesktopWorkspaceDisplay({
  diagnosticsText,
  t,
}: {
  diagnosticsText: string;
  t: Translator;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          {t("desktopworkspacesection.Diagnostics")}
        </CardTitle>
        <CardDescription>
          {t("desktopworkspacesection.DiagnosticsDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto break-all rounded-xl border border-border bg-bg px-3 py-3 text-xs-tight leading-5 text-txt">
          {diagnosticsText}
        </pre>
      </CardContent>
    </Card>
  );
}
