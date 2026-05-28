import { useCallback, useState } from "react";
import { useApp } from "../../state";
import { Button } from "../ui/button";

// z-[9998] mirrors Z_SYSTEM_BANNER in ../../lib/floating-layers.ts.
// Kept as a literal so Tailwind v4's source scanner emits the utility.

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
      ? t("restartbanner.SingleReasonPending", { reason: reasons[0] })
      : reasons.length > 1
        ? t("restartbanner.MultipleReasonsPending", {
            count: reasons.length,
          })
        : t("restartbanner.RestartRequired");

  return (
    <div
      className="fixed bottom-4 right-4 z-[9998] flex flex-col gap-2 rounded-sm px-4 py-3 text-sm font-medium "
      style={{
        background: "color-mix(in srgb, var(--bg) 95%, var(--accent) 5%)",
        border: "1px solid color-mix(in srgb, var(--accent) 25%, transparent)",
        color: "var(--text)",
        maxWidth: "22rem",
        backdropFilter: "blur(12px)",
      }}
      role="status"
      aria-live="polite"
    >
      <span className="leading-snug">{text}</span>
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={dismissRestartBanner}
          className="rounded-sm px-3 py-1 text-xs text-muted hover:bg-bg-hover"
        >
          {t("restartbanner.Later")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleRestart}
          disabled={restarting}
          className="rounded-sm px-3 py-1 text-xs font-semibold border-transparent"
          style={{
            background: "var(--accent)",
            color: "var(--accent-foreground)",
          }}
        >
          {restarting
            ? t("restartbanner.Restarting")
            : t("restartbanner.RestartNow")}
        </Button>
      </div>
    </div>
  );
}
