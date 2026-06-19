import { SettingsGroup, SettingsRow } from "./settings-layout";

type Translator = (key: string, options?: Record<string, unknown>) => string;

export function DesktopWorkspaceDisplay({
  diagnosticsText,
  t,
}: {
  diagnosticsText: string;
  t: Translator;
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
