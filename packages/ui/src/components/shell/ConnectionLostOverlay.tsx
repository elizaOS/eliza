import { Button, Card, CardContent, CardHeader } from "@elizaos/ui";
import { useState } from "react";
import { isElectrobunRuntime } from "../../bridge";
import { useApp } from "../../state";

const OVERLAY_SHELL_CLASS =
  "fixed inset-0 z-[1001] flex min-h-screen w-full items-center justify-center overflow-hidden bg-bg/80 px-4 py-6 font-body text-txt backdrop-blur-sm sm:px-6";
const OVERLAY_CARD_CLASS =
  "relative z-10 w-full max-w-[640px] overflow-hidden border border-border/60 bg-card/95 shadow-[0_30px_120px_rgba(0,0,0,0.36)] backdrop-blur-xl";

export function ConnectionLostOverlay() {
  const { backendConnection, relaunchDesktop, retryBackendConnection, t } =
    useApp();
  const [busy, setBusy] = useState<"restart" | null>(null);
  const desktopRuntime = isElectrobunRuntime();

  if (
    backendConnection.state !== "failed" ||
    !backendConnection.showDisconnectedUI
  ) {
    return null;
  }

  const handleRestart = async () => {
    if (busy) return;
    setBusy("restart");
    try {
      if (desktopRuntime) {
        await relaunchDesktop();
        return;
      }

      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="connection-lost-title"
      className={OVERLAY_SHELL_CLASS}
    >
      <Card className={OVERLAY_CARD_CLASS}>
        <CardHeader className="bg-danger/5 pb-6 pt-6">
          <div className="flex flex-col gap-4">
            <div className="space-y-2">
              <h1
                id="connection-lost-title"
                className="text-xl font-semibold leading-tight text-danger"
              >
                {t("connectionlostoverlay.LostBackendConnection", {
                  defaultValue: "Lost backend connection.",
                })}
              </h1>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="rounded-2xl border border-border/50 bg-bg/35 p-4 text-sm text-muted shadow-sm">
            {t("connectionlostoverlay.AttemptsExhausted", {
              defaultValue:
                "Realtime reconnect attempts exhausted: {{attempts}}.",
              attempts: String(backendConnection.maxReconnectAttempts),
            })}
          </div>

          <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center">
            <Button
              variant="default"
              size="lg"
              onClick={() => {
                void handleRestart();
              }}
              disabled={busy !== null}
              className="w-full sm:w-auto sm:min-w-[11rem]"
            >
              {busy === "restart"
                ? t("restartbanner.Restarting", {
                    defaultValue: "Restarting...",
                  })
                : t("finetuningview.Restart", {
                    defaultValue: desktopRuntime ? "Restart App" : "Restart",
                  })}
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={retryBackendConnection}
              disabled={busy !== null}
              className="w-full sm:w-auto sm:min-w-[11rem]"
            >
              {t("vectorbrowserview.RetryConnection", {
                defaultValue: "Retry Connection",
              })}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
