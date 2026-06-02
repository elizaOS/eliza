import * as React from "react";
import { TRAY_ACTION_EVENT } from "../events";
import { trayActionToOnboardingChoice } from "./onboarding-intent";
import { useFirstRunController } from "./use-first-run-controller";

/**
 * First-run onboarding as a notification-style card — no full page, no tray
 * menu. A top-right notification (like a native OS notification) with two
 * buttons: Use Local / Eliza Cloud (no default). Voice leads when available
 * via the existing controller (`applyVoiceTranscript` maps spoken
 * "local"/"cloud" to the same finish path), and the macOS tray menu can drive
 * the same choice (TRAY_ACTION_EVENT). Reuses `useFirstRunController` for the
 * real provisioning.
 *
 * NOTE: Electrobun's native notifications are text-only (no action buttons), so
 * this is an in-app notification card rather than an OS notification.
 */
export function CompactOnboarding(): React.ReactElement {
  const c = useFirstRunController();
  const { busyText, error, localRuntimeAvailable, voice, cloudOnly } = c;
  const busy = busyText !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: greet once on mount; re-running would restart voice every render.
  React.useEffect(() => {
    if (voice.supported && !cloudOnly) {
      void c.startVoice().catch(() => {});
    }
    return () => {
      void c.stopVoice().catch(() => {});
    };
  }, []);
  // Detect whether this component is running inside the onboarding overlay
  // shell (a separate transparent NSWindow). If so, closing the window after
  // the first-run API completes triggers the main process to create the
  // dashboard. In the full app shell `completeFirstRun` handles the transition.
  const isOverlayShell = React.useMemo(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("shellMode") ===
        "onboarding-overlay",
    [],
  );

  const choose = React.useCallback(
    (runtime: "local" | "cloud") => {
      c.updateDraft("runtime", runtime);
      void (async () => {
        try {
          await c.finishRuntime();
          // In the overlay shell, the first-run API call succeeded but
          // completeFirstRun() only sets React state in this isolated window.
          // Close the window so the main process can open the dashboard.
          if (isOverlayShell) {
            window.close();
          }
        } catch {
          // Errors are already surfaced via the controller's error state.
        }
      })();
    },
    [c, isOverlayShell],
  );

  // The macOS tray menu can drive the same choice: tray clicks dispatch
  // TRAY_ACTION_EVENT; map onboarding ids → choose.
  React.useEffect(() => {
    const onTrayAction = (event: Event) => {
      const itemId =
        (event as CustomEvent<{ itemId?: string }>).detail?.itemId ?? "";
      const choice = trayActionToOnboardingChoice(itemId);
      if (choice === "local" || choice === "cloud") {
        choose(choice);
      }
    };
    document.addEventListener(TRAY_ACTION_EVENT, onTrayAction);
    return () => document.removeEventListener(TRAY_ACTION_EVENT, onTrayAction);
  }, [choose]);

  const message =
    error ??
    busyText ??
    (voice.listening
      ? "Listening — say \u201clocal\u201d or \u201ccloud\u201d\u2026"
      : "Run on-device, or sign in to Eliza Cloud. Say it or tap.");

  return (
    <div className="pointer-events-none fixed inset-0 flex items-start justify-end p-4">
      <div className="flex w-full max-w-[22rem] flex-col items-stretch gap-3">
        <div
          data-testid="onboarding-toast"
          className="pointer-events-auto flex flex-col gap-3 rounded-2xl border border-border bg-bg/95 p-4 shadow-2xl backdrop-blur"
        >
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${
                voice.listening
                  ? "bg-accent/15 ring-1 ring-accent"
                  : "bg-bg-hover"
              }`}
            >
              🎙️
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-txt-strong">
                Set up your agent
              </span>
              <span
                className={`text-xs ${error ? "text-danger" : "text-muted"}`}
              >
                {message}
              </span>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            {localRuntimeAvailable ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => choose("local")}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Use Local
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => choose("cloud")}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-bg-hover disabled:opacity-50"
            >
              Eliza Cloud
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
