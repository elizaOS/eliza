import { useState } from "react";
import { client } from "../../api";
import { useBranding } from "../../config/branding";
import { type BugReportDraft, useOptionalBugReport } from "../../hooks";
import type { StartupErrorState } from "../../state";
import { useApp } from "../../state";
import { Banner } from "../ui/banner";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "../ui/card";
import { StatusBadge } from "../ui/status-badge";

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
  "relative z-10 w-full max-w-[720px] overflow-hidden border border-border/60 bg-card/95 shadow-[0_30px_120px_rgba(0,0,0,0.36)] backdrop-blur-xl";

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

function normalizeReportUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function StartupFailureView({
  error,
  onRetry,
}: StartupFailureViewProps) {
  const { t } = useApp();
  const branding = useBranding();
  const bugReport = useOptionalBugReport();
  const [reportState, setReportState] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const isBackendUnreachable = error.reason === "backend-unreachable";
  const reasonLabel = startupReasonLabel(t, error.reason);
  const startupDraft = buildStartupBugReportDraft(reasonLabel, error);

  async function handleShareReport() {
    setReportState("submitting");
    setReportMessage(null);
    try {
      const info = await client.checkBugReportInfo();
      const result = await client.submitBugReport({
        category: "startup-failure",
        description: `${branding.appName} startup failed: ${reasonLabel}`,
        stepsToReproduce: `1. Launch ${branding.appName}\n2. Wait for startup to complete\n3. Observe the startup failure screen`,
        expectedBehavior: `${branding.appName} should finish startup successfully.`,
        actualBehavior: error.message,
        environment:
          info.platform === "darwin"
            ? "macOS"
            : info.platform === "win32"
              ? "Windows"
              : info.platform === "linux"
                ? "Linux"
                : info.platform || "Unknown",
        nodeVersion: info.nodeVersion,
        logs: [
          `reason=${error.reason}`,
          `phase=${error.phase}`,
          error.status ? `status=${error.status}` : null,
          error.path ? `path=${error.path}` : null,
          error.detail ? `detail=${error.detail}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        startup: {
          reason: error.reason,
          phase: error.phase,
          message: error.message,
          detail: error.detail,
          status: error.status,
          path: error.path,
        },
      });
      const safeResultUrl = normalizeReportUrl(result.url);
      if (safeResultUrl) {
        setReportState("success");
        setReportMessage(`Report shared: ${safeResultUrl}`);
        return;
      }
      if (result.accepted) {
        setReportState("success");
        setReportMessage("Diagnostic report shared successfully.");
        return;
      }
      if (result.fallback) {
        setReportState("error");
        setReportMessage(
          bugReport
            ? "Automatic sharing is unavailable. Use Report Bug to review and submit it manually."
            : "Automatic sharing is unavailable on this screen.",
        );
        return;
      }
      setReportState("error");
      setReportMessage("Failed to share diagnostic report.");
    } catch (submitError) {
      setReportState("error");
      setReportMessage(
        submitError instanceof Error
          ? submitError.message
          : "Failed to share diagnostic report.",
      );
    }
  }

  return (
    <div className={SCREEN_SHELL_CLASS}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(220,38,38,0.1),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_42%)]"
      />
      <Card className={SCREEN_CARD_CLASS}>
        <CardHeader className="bg-danger/5 pb-6 pt-6">
          <div className="flex flex-col gap-4">
            <StatusBadge
              label={reasonLabel}
              variant="danger"
              withDot
              className="self-start"
            />
            <div className="space-y-2">
              <h1 className="text-xl font-semibold leading-tight text-danger">
                {t("startupfailureview.StartupFailed")} {reasonLabel}
              </h1>
            </div>
            {isBackendUnreachable ? null : null}
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5 pt-6">
          {reportMessage ? (
            <Banner
              variant={reportState === "success" ? "info" : "error"}
              className="rounded-xl text-xs"
            >
              {reportMessage}
            </Banner>
          ) : null}
          {error.detail ? (
            <section className="space-y-2 rounded-2xl border border-border/50 bg-bg/35 p-4 shadow-sm">
              <div className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                {t("common.details", {
                  defaultValue: "Details",
                })}
              </div>
              <pre className="max-h-60 overflow-auto rounded-xl border border-border bg-bg-muted p-3 text-xs leading-relaxed text-muted whitespace-pre-wrap break-words">
                {error.detail}
              </pre>
            </section>
          ) : (
            <CardDescription className="max-w-[56ch] leading-relaxed">
              {reasonLabel}
            </CardDescription>
          )}

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
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                void handleShareReport();
              }}
              disabled={reportState === "submitting"}
              className="w-full sm:w-auto sm:min-w-[12rem]"
            >
              {reportState === "submitting"
                ? "Sharing report..."
                : "Share diagnostic report"}
            </Button>
            {isBackendUnreachable ? (
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
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
