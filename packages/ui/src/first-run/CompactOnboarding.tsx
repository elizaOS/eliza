import * as React from "react";
import { TRAY_ACTION_EVENT } from "../events";
import { OnboardingVoicePill } from "./OnboardingVoicePill";
import { trayActionToOnboardingChoice } from "./onboarding-intent";
import { useFirstRunController } from "./use-first-run-controller";

export interface CompactOnboardingProps {
  showVoicePill?: boolean;
}

export function CompactOnboarding({
  showVoicePill = false,
}: CompactOnboardingProps): React.ReactElement {
  const c = useFirstRunController();
  const { busyText, cloudError, error, submitting, voice, cloudOnly } = c;
  const busy = submitting;

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

  const chooseCloud = React.useCallback(() => {
    c.updateDraft("runtime", "cloud");
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
  }, [c, isOverlayShell]);

  // The macOS tray menu can drive the same choice: tray clicks dispatch
  // TRAY_ACTION_EVENT; map onboarding ids → choose.
  React.useEffect(() => {
    const onTrayAction = (event: Event) => {
      const itemId =
        (event as CustomEvent<{ itemId?: string }>).detail?.itemId ?? "";
      const choice = trayActionToOnboardingChoice(itemId);
      if (choice === "cloud") {
        chooseCloud();
      }
    };
    document.addEventListener(TRAY_ACTION_EVENT, onTrayAction);
    return () => document.removeEventListener(TRAY_ACTION_EVENT, onTrayAction);
  }, [chooseCloud]);

  const statusMessage = error ?? cloudError ?? busyText;

  return (
    <>
      <div className="first-run-screen pointer-events-none fixed inset-0 p-6 text-white">
        <div className="mx-auto flex h-full w-full max-w-[22rem] flex-col items-center justify-start pt-[calc(var(--safe-area-top,0px)+24rem)] text-center">
          <div
            data-testid="onboarding-toast"
            className="pointer-events-auto flex flex-col items-center text-white"
          >
            <button
              type="button"
              disabled={busy}
              onClick={() => void c.toggleVoice()}
              aria-label={voice.listening ? "Stop listening" : "Tap to speak"}
              className={`relative grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full ring-1 transition-transform focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#FF5800] disabled:opacity-60 ${
                voice.listening
                  ? "scale-105 bg-white/25 ring-white shadow-[0_0_34px_rgba(255,255,255,0.55)]"
                  : "bg-white/10 ring-white/35 shadow-[0_0_24px_rgba(255,255,255,0.26)]"
              }`}
            >
              <span
                className={`absolute inset-0 rounded-full ${
                  voice.listening
                    ? "bg-[radial-gradient(circle_at_32%_28%,rgba(255,255,255,0.98),rgba(255,255,255,0.28)_21%,transparent_40%),conic-gradient(from_210deg,#FF5800,#ff8a1f,#fff0b8,#ffffff,#ff6f91,#FF5800)]"
                    : "bg-[radial-gradient(circle_at_32%_28%,rgba(255,255,255,0.94),rgba(255,255,255,0.2)_22%,transparent_42%),conic-gradient(from_210deg,#FF5800,#ff7a18,#ffd166,#fff7df,#ff8aa6,#FF5800)]"
                }`}
              />
              <span className="absolute inset-[6px] rounded-full bg-[radial-gradient(circle_at_36%_32%,rgba(255,255,255,0.82),rgba(255,88,0,0.24)_42%,transparent_72%)]" />
              <span className="absolute inset-[15px] rounded-full bg-white/90 shadow-[inset_0_1px_2px_rgba(255,255,255,0.9),0_0_14px_rgba(255,88,0,0.52)]" />
            </button>
            {statusMessage ? (
              <p className="mt-5 min-h-5 text-sm leading-snug text-white">
                {statusMessage}
              </p>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={chooseCloud}
              className="mt-7 min-h-10 rounded-[2px] border border-white bg-transparent px-8 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-50"
            >
              Connect
            </button>
          </div>
        </div>
      </div>
      {showVoicePill ? <OnboardingVoicePill /> : null}
    </>
  );
}
