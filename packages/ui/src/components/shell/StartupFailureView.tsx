/**
 * Terminal-state screen shown when startup can't reach the main shell: names the
 * failure reason (backend timeout/unreachable, agent timeout/error, missing
 * asset, unknown), offers a retry, and — where a bug reporter is mounted —
 * pre-fills a startup bug report from the error + captured logs. One of the
 * `StartupShell` views; rendered by `StartupShell` when `view.kind === "error"`.
 */

import { AlertCircle } from "lucide-react";
import { useBranding } from "../../config/branding";
import { type BugReportDraft, useOptionalBugReport } from "../../hooks";
import { startFreshFirstRunReload } from "../../platform";
import type { StartupErrorState } from "../../state";
import { type useApp, useAppSelector } from "../../state";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";

function startupReasonLabel(
  t: ReturnType<typeof useApp>["t"],
  reason: StartupErrorState["reason"],
): string {
  switch (reason) {
    case "backend-timeout":
      return t("startupfailureview.BackendTimeout", {
        defaultValue: "Taking longer than expected",
      });
    case "backend-unreachable":
      return t("startupfailureview.BackendUnreachable", {
        defaultValue: "Can't connect",
      });
    case "agent-timeout":
      return t("startupfailureview.AgentTimeout", {
        defaultValue: "Your agent is taking longer than expected",
      });
    case "agent-error":
      return t("startupfailureview.AgentError", {
        defaultValue: "Your agent couldn't start",
      });
    case "asset-missing":
      return t("startupfailureview.AssetMissing", {
        defaultValue: "Something needed is missing",
      });
    case "unknown":
      return t("startupfailureview.Unknown", {
        defaultValue: "Something went wrong",
      });
  }
}

const SCREEN_SHELL_CLASS =
  "relative flex min-h-screen w-full items-center justify-center overflow-hidden px-4 py-6 font-body text-txt sm:px-6";
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
  const t = useAppSelector((s) => s.t);
  const branding = useBranding();
  const bugReport = useOptionalBugReport();
  const reasonLabel = startupReasonLabel(t, error.reason);
  const startupDraft = buildStartupBugReportDraft(reasonLabel, error);

  return (
    <Card asChild variant="sandboxFrame" className={SCREEN_SHELL_CLASS}>
      <div>
        <Card
          surface="cardOverlay"
          border="subtle"
          className="relative z-10 w-full max-w-[720px] overflow-hidden"
        >
          <CardHeader className="pb-6 pt-6">
            <div className="flex flex-col gap-4">
              <Badge
                asChild
                variant="statusDanger"
                size="providerMark"
                aria-label={reasonLabel}
                className="size-9"
                role="img"
                title={reasonLabel}
              >
                <span>
                  <AlertCircle className="size-5" aria-hidden />
                </span>
              </Badge>
              <h1 className="text-xl font-semibold leading-tight text-destructive">
                {reasonLabel}
              </h1>
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-5 pt-6">
            {/* The human-readable reason, surfaced front-and-centre (not buried in
              the bug-report draft) so a user staring at an offline phone learns
              what actually went wrong. */}
            <p className="text-sm leading-relaxed text-txt">
              {t("startupfailureview.TryAgainDescription", {
                defaultValue:
                  "Try again in a moment. If this keeps happening, the details below can help diagnose the problem.",
              })}
            </p>
            <Card
              asChild
              surface="backgroundSubtle"
              border="subtle"
              className="group"
            >
              <details>
                <Button
                  asChild
                  variant="disclosureMuted"
                  size="content"
                  className="cursor-pointer px-3 py-2 font-semibold"
                >
                  <summary>
                    {t("startupfailureview.TechnicalDetails", {
                      defaultValue: "Technical details",
                    })}
                  </summary>
                </Button>
                <Card asChild variant="topDivider">
                  <pre className="max-h-60 overflow-auto p-3 text-xs leading-relaxed text-muted whitespace-pre-wrap break-words">
                    {[error.message, error.detail].filter(Boolean).join("\n\n")}
                  </pre>
                </Card>
              </details>
            </Card>

            <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center">
              {error.reason === "backend-unreachable" ? (
                <Button
                  variant="default"
                  size="lg"
                  onClick={() => startFreshFirstRunReload()}
                  className="w-full sm:w-auto sm:min-w-[11rem]"
                  data-testid="startup-start-over"
                >
                  {t("startupfailureview.StartOver", {
                    defaultValue: "Start over",
                  })}
                </Button>
              ) : null}
              <Button
                variant={
                  error.reason === "backend-unreachable" ? "outline" : "default"
                }
                size="lg"
                onClick={onRetry}
                className="w-full sm:w-auto sm:min-w-[11rem]"
                data-testid="startup-retry"
              >
                {t("startupfailureview.RetryStartup")}
              </Button>
              {bugReport ? (
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => bugReport.open(startupDraft)}
                  className="w-full sm:w-auto sm:min-w-[10rem]"
                  data-testid="startup-report-bug"
                >
                  {t("bugreportmodal.ReportABug")}
                </Button>
              ) : null}
              {error.reason === "backend-unreachable" ? (
                <Button
                  variant="outline"
                  size="lg"
                  asChild
                  className="w-full sm:w-auto sm:min-w-[10rem]"
                  data-testid="startup-open-app"
                >
                  <a href={branding.appUrl} target="_blank" rel="noreferrer">
                    {t("startupfailureview.OpenApp")}
                  </a>
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </Card>
  );
}
