import { useAppSelectorShallow } from "../../state";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

// z-[9999] mirrors Z_SYSTEM_CRITICAL in ../../lib/floating-layers.ts.
// Kept as a literal so Tailwind v4's source scanner emits the utility.

/**
 * Connection status surface for the app shell. Two visually distinct states:
 *
 * - "reconnecting" — a transient, informational indicator. Rendered as a
 *   floating pill OVERLAY (absolutely positioned, out of document flow) so that
 *   it appearing/disappearing on every reconnect attempt never reflows the
 *   header or page content. This is the fix for the layout shift the in-flow
 *   bar used to cause each time the socket blipped.
 * - "failed" — a persistent, actionable "connection lost" alert with Retry /
 *   Dismiss. It stays in document flow (a full-width bar that pushes content
 *   down) because it is a durable state the user must act on, and it keeps the
 *   macOS Electrobun titlebar-banner integration (data-window-titlebar-banner).
 */
export function ConnectionFailedBanner() {
  const {
    t,
    backendConnection,
    backendDisconnectedBannerDismissed,
    dismissBackendDisconnectedBanner,
    retryBackendConnection,
  } = useAppSelectorShallow((s) => ({
    t: s.t,
    backendConnection: s.backendConnection,
    backendDisconnectedBannerDismissed: s.backendDisconnectedBannerDismissed,
    dismissBackendDisconnectedBanner: s.dismissBackendDisconnectedBanner,
    retryBackendConnection: s.retryBackendConnection,
  }));

  if (!backendConnection) return null;
  if (backendConnection.showDisconnectedUI) return null;

  if (backendConnection.state === "reconnecting") {
    // Overlay layer: absolutely positioned within the shell's relative content
    // column so it floats above the header/content and consumes NO layout
    // height — mounting/unmounting it does not shift anything below. The
    // wrapper is click-through (pointer-events-none); the pill is a status
    // readout with nothing to interact with.
    return (
      <div className="pointer-events-none absolute inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-[9999] flex justify-center">
        <div
          role="status"
          aria-live="polite"
          // bg-warn (--warn: #ff8a24) is a light-ish orange in every theme, so
          // white text fails WCAG contrast (~2:1). Pin the foreground to
          // near-black (--brand-black) for a readable ~8:1 on the orange, rather
          // than the theme-flipping --accent-foreground that renders white here.
          className="flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-full bg-warn px-4 py-1.5 text-sm font-semibold text-[color:var(--brand-black)] shadow-md"
        >
          <Spinner
            size={14}
            className="shrink-0 text-[color:var(--brand-black)]"
            aria-label={t("aria.reconnecting")}
          />
          <span className="truncate">
            {t("connectionfailedbanner.ReconnectingAtt")}{" "}
            {backendConnection.reconnectAttempt}/
            {backendConnection.maxReconnectAttempts})
          </span>
        </div>
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
        className="mobile-top-banner shrink-0 z-[9999] flex items-center justify-between gap-3 bg-danger px-4 py-2 text-sm font-medium text-white "
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
