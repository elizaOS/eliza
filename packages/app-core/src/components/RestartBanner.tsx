import { useCallback, useState } from "react";
import { isElectrobunRuntime } from "../bridge";
import { useApp } from "../state";

export function RestartBanner() {
  const {
    pendingRestart,
    pendingRestartReasons,
    restartBannerDismissed,
    dismissRestartBanner,
    triggerRestart,
    t,
  } = useApp();

  const [restarting, setRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await triggerRestart();
    } finally {
      setRestarting(false);
    }
  }, [triggerRestart]);

  if (!pendingRestart || restartBannerDismissed) return null;

  const reasons = pendingRestartReasons;
  const text =
    reasons.length === 1
      ? `${reasons[0]} - restart to apply.`
      : reasons.length > 1
        ? `${reasons.length} changes pending - restart to apply.`
        : "Restart required to apply changes.";

  return (
    <div
      className="fixed left-0 right-0 z-[9998] flex items-center justify-between gap-3 px-4 py-2 text-[13px] font-medium shadow-lg"
      style={{
        top: isElectrobunRuntime() ? 40 : 0,
        background: "color-mix(in srgb, var(--accent) 15%, var(--bg) 85%)",
        borderBottom:
          "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
        display: "flex",
        color: "var(--text)",
      }}
    >
      <span className="truncate">{text}</span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={dismissRestartBanner}
          className="rounded px-3 py-1 text-[12px] transition-colors"
          style={{ color: "var(--muted)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          {t("restartbanner.Later")}
        </button>
        <button
          type="button"
          onClick={handleRestart}
          disabled={restarting}
          className="rounded px-3 py-1 text-[12px] font-semibold transition-colors disabled:opacity-60"
          style={{ background: "#f0b232", color: "#000" }}
        >
          {restarting ? "Restarting..." : "Restart Now"}
        </button>
      </div>
    </div>
  );
}
