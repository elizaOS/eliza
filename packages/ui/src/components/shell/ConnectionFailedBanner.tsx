import { useApp } from "../../state";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

// z-[9999] mirrors Z_SYSTEM_CRITICAL in ../../lib/floating-layers.ts.
// Kept as a literal so Tailwind v4's source scanner emits the utility.

/**
 * Banner shown during WebSocket reconnection attempts.
 * Renders in document flow to push the header and content down.
 */
export function ConnectionFailedBanner() {
  const { t } = useApp();
  const {
    backendConnection,
    backendDisconnectedBannerDismissed,
    dismissBackendDisconnectedBanner,
    retryBackendConnection,
  } = useApp();

  if (!backendConnection) return null;
  if (backendConnection.showDisconnectedUI) return null;

  if (backendConnection.state === "reconnecting") {
    return (
      <div
        role="status"
        aria-live="polite"
        data-window-titlebar-banner="true"
        className="shrink-0 z-[9999] flex items-center gap-3 bg-warn px-4 py-2 text-sm font-medium text-[color:var(--accent-foreground)] "
      >
        <Spinner
          size={16}
          className="shrink-0 text-[color:var(--accent-foreground)]"
          aria-label={t("aria.reconnecting")}
        />
        <span className="truncate">
          {t("connectionfailedbanner.ReconnectingAtt")}{" "}
          {backendConnection.reconnectAttempt}/
          {backendConnection.maxReconnectAttempts})
        </span>
      </div>
    );
  }

  if (
    backendConnection.state === "failed" &&
    !backendDisconnectedBannerDismissed
  ) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        data-window-titlebar-banner="true"
        className="shrink-0 z-[9999] flex items-center justify-between gap-3 bg-danger px-4 py-2 text-sm font-medium text-white "
      >
        <span className="truncate">
          {t("connectionfailedbanner.ConnectionLostAfte")}{" "}
          {backendConnection.maxReconnectAttempts}{" "}
          {t("connectionfailedbanner.attemptsRealTime")}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={dismissBackendDisconnectedBanner}
            className="rounded-sm px-3 py-1 text-xs text-white/80 hover:bg-white/15 hover:text-white"
          >
            {t("common.dismiss")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={retryBackendConnection}
            className="rounded-sm bg-card px-3 py-1 text-xs font-semibold text-destructive hover:bg-bg-hover border-transparent"
          >
            {t("vectorbrowserview.RetryConnection")}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
