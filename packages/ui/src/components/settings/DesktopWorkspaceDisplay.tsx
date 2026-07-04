/**
 * Read-only diagnostics card for the Desktop Workspace section — renders the
 * pre-formatted `diagnosticsText` (built by DesktopWorkspaceDisplay.hooks) in a
 * scrollable `<pre>` inside the settings layout.
 */

import type { TranslateFn } from "../../types";
import { SettingsGroup, SettingsRow } from "./settings-layout";

export function DesktopWorkspaceDisplay({
  diagnosticsText,
  t,
}: {
  diagnosticsText: string;
  t: TranslateFn;
}) {
  return (
    <SettingsGroup
      title={t("desktopworkspacesection.Diagnostics")}
      description={t("desktopworkspacesection.DiagnosticsDescription")}
    >
      <SettingsRow label={t("desktopworkspacesection.Diagnostics")} stacked>
        <pre className="overflow-x-auto break-all rounded-sm border border-border bg-bg px-3 py-3 text-xs-tight leading-5 text-txt">
          {diagnosticsText}
        </pre>
      </SettingsRow>
    </SettingsGroup>
  );
}
