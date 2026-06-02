import * as React from "react";
import { useFirstRunController } from "./use-first-run-controller";

/**
 * First-run onboarding as a single toast — no full page, no card. Pick local
 * or cloud (no default), or just say it: voice leads via the existing
 * controller (`applyVoiceTranscript` maps spoken "local"/"cloud" to the same
 * finish path). Reuses `useFirstRunController` for the real provisioning.
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

  const choose = React.useCallback(
    (runtime: "local" | "cloud") => {
      c.updateDraft("runtime", runtime);
      void c.finishRuntime();
    },
    [c],
  );

  const message =
    error ??
    busyText ??
    (voice.listening
      ? "Listening — say “local” or “cloud”…"
      : "Set up your agent — say “local” or “cloud”, or pick:");

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center p-6">
      <div
        data-testid="onboarding-toast"
        className="pointer-events-auto flex w-full max-w-[30rem] flex-wrap items-center gap-3 rounded-lg border border-border bg-bg px-4 py-3 shadow-xl"
      >
        <span className={`text-sm ${error ? "text-danger" : "text-txt"}`}>
          {message}
        </span>
        <div className="ml-auto flex gap-2">
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
  );
}
