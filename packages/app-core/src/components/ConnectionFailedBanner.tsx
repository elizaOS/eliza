import { isElectrobunRuntime } from "../bridge";
import { useApp } from "../state";

/**
 * Banner shown during WebSocket reconnection attempts (amber) and
 * after all attempts are exhausted (red). Offers Retry when failed.
 */
export function ConnectionFailedBanner() {
  const { t } = useApp();
  const bannerTop = isElectrobunRuntime() ? 40 : 0;
  const {
    backendConnection,
    backendDisconnectedBannerDismissed,
    dismissBackendDisconnectedBanner,
    retryBackendConnection,
  } = useApp();

  if (!backendConnection) return null;

  if (backendConnection.state === "reconnecting") {
    return (
      <div
        className="fixed left-0 right-0 z-[9999] flex items-center gap-3 bg-amber-500 px-4 py-2 text-[13px] font-medium text-white shadow-lg"
        style={{ top: bannerTop }}
      >
        <svg
          className="h-4 w-4 shrink-0 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          aria-label="Reconnecting"
          role="img"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
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
        className="fixed left-0 right-0 z-[9999] flex items-center justify-between gap-3 bg-danger px-4 py-2 text-[13px] font-medium text-white shadow-lg"
        style={{ top: bannerTop }}
      >
        <span className="truncate">
          {t("connectionfailedbanner.ConnectionLostAfte")}{" "}
          {backendConnection.maxReconnectAttempts}{" "}
          {t("connectionfailedbanner.attemptsRealTime")}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={dismissBackendDisconnectedBanner}
            className="rounded px-3 py-1 text-[12px] text-red-100 hover:bg-red-700 transition-colors cursor-pointer"
          >
            {t("skillsview.Dismiss")}
          </button>
          <button
            type="button"
            onClick={retryBackendConnection}
            className="rounded bg-white px-3 py-1 text-[12px] font-semibold text-red-700 hover:bg-red-50 transition-colors cursor-pointer"
          >
            {t("vectorbrowserview.RetryConnection")}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
