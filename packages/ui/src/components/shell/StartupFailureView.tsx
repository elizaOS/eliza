import { AlertCircle } from "lucide-react";
import { useBranding } from "../../config/branding";
import { type BugReportDraft, useOptionalBugReport } from "../../hooks";
import { startFreshFirstRunReload } from "../../platform";
import type { StartupErrorState } from "../../state";
import { useApp } from "../../state";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";

function startupReasonLabel(
  t: ReturnType<typeof useApp>["t"],
  reason: StartupErrorState["reason"],
): string {
  switch (reason) {
    case "backend-timeout":
      return t("startupfailureview.BackendTimeout", {
        defaultValue: "Backend Timeout",
      });
    case "backend-unreachable":
      return t("startupfailureview.BackendUnreachable", {
        defaultValue: "Backend Unreachable",
      });
    case "agent-timeout":
      return t("startupfailureview.AgentTimeout", {
        defaultValue: "Agent Timeout",
      });
    case "agent-error":
      return t("startupfailureview.AgentError", {
        defaultValue: "Agent Error",
      });
    case "asset-missing":
      return t("startupfailureview.AssetMissing", {
        defaultValue: "Asset Missing",
      });
    case "unknown":
      return t("startupfailureview.Unknown", {
        defaultValue: "Unknown Error",
      });
  }
}

const SCREEN_SHELL_CLASS =
  "relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-bg px-4 py-6 font-body text-txt sm:px-6";
const SCREEN_CARD_CLASS =
  "relative z-10 w-full max-w-[720px] overflow-hidden border border-border/60 bg-card/95 shadow-lg";

interface StartupFailureViewProps {
  error: StartupErrorState;
  onRetry: () => void;
}

function buildStartupBugReportDraft(
  reasonLabel: string,
  error: StartupErrorState,
): BugReportDraft {
  const logs = [
    `Reason: ${error.reason}`,
    `Phase: ${error.phase}`,
    typeof error.status === "number" ? `Status: ${error.status}` : null,
    error.path ? `Path: ${error.path}` : null,
    error.detail ? `Detail: ${error.detail}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    description: `${reasonLabel}: ${error.message}`.slice(0, 80),
    stepsToReproduce:
      "1. Launch the desktop app.\n2. Wait for startup to fail.\n3. Observe the startup failure screen.",
    expectedBehavior: "The app should finish startup and show the main shell.",
    actualBehavior: error.message,
    logs,
  };
}

export function StartupFailureView({
  error,
  onRetry,
}: StartupFailureViewProps) {
  const { t } = useApp();
  const branding = useBranding();
  const bugReport = useOptionalBugReport();
  const reasonLabel = startupReasonLabel(t, error.reason);
  const startupDraft = buildStartupBugReportDraft(reasonLabel, error);

  return (
    <div className={SCREEN_SHELL_CLASS}>
      <Card className={SCREEN_CARD_CLASS}>
        <CardHeader className="border-b border-border/10 bg-[#F7F9FF] pb-6 pt-6">
          <div className="flex flex-col gap-4">
            <span
              aria-label={reasonLabel}
              className="inline-flex h-9 w-9 items-center justify-center rounded-sm border border-destructive/35 bg-destructive/12 text-destructive"
              role="img"
              title={reasonLabel}
            >
              <AlertCircle className="h-5 w-5" aria-hidden />
            </span>
            <h1 className="text-xl font-semibold leading-tight text-[#0B35F1]">
              {t("startupfailureview.StartupFailed")} {reasonLabel}
            </h1>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5 pt-6">
          {error.detail ? (
            <section className="space-y-2 rounded-sm border border-border/50 bg-bg/35 p-4">
              <div className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                {t("common.details", { defaultValue: "Details" })}
              </div>
              <pre className="max-h-60 overflow-auto rounded-sm border border-border/40 bg-card p-3 text-xs leading-relaxed text-muted whitespace-pre-wrap break-words">
                {error.detail}
              </pre>
            </section>
          ) : null}

          <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center">
            <Button
              variant="default"
              size="lg"
              onClick={onRetry}
              className="w-full sm:w-auto sm:min-w-[11rem]"
            >
              {t("startupfailureview.RetryStartup")}
            </Button>
            {bugReport ? (
              <Button
                variant="outline"
                size="lg"
                onClick={() => bugReport.open(startupDraft)}
                className="w-full sm:w-auto sm:min-w-[10rem]"
              >
                {t("bugreportmodal.ReportABug")}
              </Button>
            ) : null}
            {error.reason === "backend-unreachable" ? (
              <>
                {/* Escape the unreachable saved backend: abandon it and start
                    over on a local agent (the "or reset" the message promises). */}
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => startFreshFirstRunReload()}
                  className="w-full sm:w-auto sm:min-w-[10rem]"
                >
                  {t("startupfailureview.StartOver", {
                    defaultValue: "Start over",
                  })}
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  asChild
                  className="w-full sm:w-auto sm:min-w-[10rem]"
                >
                  <a href={branding.appUrl} target="_blank" rel="noreferrer">
                    {t("startupfailureview.OpenApp")}
                  </a>
                </Button>
              </>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
