import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";

type Translator = (key: string, options?: Record<string, unknown>) => string;

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
        <pre className="overflow-x-auto break-all rounded-sm border border-border bg-bg px-3 py-3 text-xs-tight leading-5 text-txt">
          {diagnosticsText}
        </pre>
      </CardContent>
    </Card>
  );
}
