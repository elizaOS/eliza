import {
  ArrowRight,
  ChevronLeft,
  Cloud,
  HardDrive,
  Loader2,
  Server,
} from "lucide-react";
import * as React from "react";
import { TRAY_ACTION_EVENT } from "../events";
import { openExternalUrl } from "../utils/openExternalUrl";
import { trayActionToOnboardingChoice } from "./onboarding-intent";
import { useFirstRunController } from "./use-first-run-controller";

interface OptionCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  badge?: string;
  disabled?: boolean;
  onClick: () => void;
  testId: string;
}

function OptionCard({
  icon: Icon,
  title,
  subtitle,
  badge,
  disabled,
  onClick,
  testId,
}: OptionCardProps): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="group flex w-full items-center gap-3.5 rounded-xl border border-white/20 bg-white/[0.08] px-4 py-3.5 text-left transition-colors hover:bg-white/[0.16] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/15">
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[15px] font-semibold leading-tight">
            {title}
          </span>
          {badge ? (
            <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#FF5800]">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-white/70">
          {subtitle}
        </span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-white/45 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

export function CompactOnboarding(): React.ReactElement {
  const c = useFirstRunController();
  const { busyText, cloudError, error, submitting, step, draft, cloudOnly } = c;
  const busy = submitting;

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

  const finishAndMaybeClose = React.useCallback(async () => {
    try {
      await c.finishRuntime();
      if (isOverlayShell) window.close();
    } catch {
      // Errors are already surfaced via the controller's error state.
    }
  }, [c, isOverlayShell]);

  const chooseCloud = React.useCallback(() => {
    c.updateDraft("runtime", "cloud");
    void finishAndMaybeClose();
  }, [c, finishAndMaybeClose]);

  const chooseLocal = React.useCallback(() => {
    c.updateDraft("runtime", "local");
    void finishAndMaybeClose();
  }, [c, finishAndMaybeClose]);

  const chooseRemote = React.useCallback(() => {
    c.updateDraft("runtime", "remote");
    c.setStep("remote");
  }, [c]);

  // The macOS tray menu can drive the cloud choice: tray clicks dispatch
  // TRAY_ACTION_EVENT; map onboarding ids → choose.
  React.useEffect(() => {
    const onTrayAction = (event: Event) => {
      const itemId =
        (event as CustomEvent<{ itemId?: string }>).detail?.itemId ?? "";
      if (trayActionToOnboardingChoice(itemId) === "cloud") {
        chooseCloud();
      }
    };
    document.addEventListener(TRAY_ACTION_EVENT, onTrayAction);
    return () => document.removeEventListener(TRAY_ACTION_EVENT, onTrayAction);
  }, [chooseCloud]);

  // The cloud login flow surfaces its sign-in URL through cloudError as
  // "Open this link to log in: <url>" when the in-app browser open is
  // unavailable. Pull the URL out so we can render a real tappable button
  // instead of dumping the raw string at the user.
  const cloudLoginUrl = React.useMemo(() => {
    const match = (cloudError ?? "").match(/https?:\/\/\S+/);
    return match ? match[0] : null;
  }, [cloudError]);

  // While an action is in flight, show its progress (busyText) — a stale
  // cloud error from a previous attempt must not shadow "Starting local
  // agent" etc. When idle, surface the error (cloud login URLs render as a
  // button below, so they're excluded here).
  const statusMessage = busy
    ? busyText
    : (error ?? (cloudLoginUrl ? null : cloudError));

  const onRemote = step === "remote" && !cloudOnly;

  return (
    <div className="first-run-screen pointer-events-none fixed inset-0 p-6 text-white">
      <div className="mx-auto flex h-full w-full max-w-[24rem] flex-col items-center justify-start pt-[calc(var(--safe-area-top,0px)+3rem)] text-center">
        <div
          data-testid="onboarding-toast"
          className="pointer-events-auto flex w-full flex-col items-center gap-7"
        >
          {/* Brand lockup — matches the loading screen for visual continuity. */}
          <div className="flex items-center justify-center gap-3">
            <img
              src="./brand/logos/logo_white_nobg.svg"
              alt=""
              aria-hidden="true"
              className="h-11 w-11"
            />
            <span className="text-3xl font-medium leading-none tracking-normal">
              elizaOS
            </span>
          </div>

          {onRemote ? (
            <div className="flex w-full flex-col gap-4">
              <h1 className="text-center text-lg font-semibold">
                Connect a remote agent
              </h1>
              <input
                // biome-ignore lint/a11y/noAutofocus: first field of an intentional form step
                autoFocus
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={draft.remoteApiBase}
                onChange={(e) => c.updateDraft("remoteApiBase", e.target.value)}
                placeholder="https://agent.example.com"
                className="w-full rounded-lg border border-white/30 bg-white/10 px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-white/45 focus:border-white/70"
              />
              <input
                type="password"
                value={draft.remoteToken}
                onChange={(e) => c.updateDraft("remoteToken", e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void finishAndMaybeClose();
                }}
                placeholder="Access token (if required)"
                className="w-full rounded-lg border border-white/30 bg-white/10 px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-white/45 focus:border-white/70"
              />
              <div className="mt-1 flex items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => c.setStep("runtime")}
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/10 disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </button>
                <button
                  type="button"
                  data-testid="onboarding-remote-connect"
                  disabled={busy || draft.remoteApiBase.trim().length === 0}
                  onClick={() => void finishAndMaybeClose()}
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-white px-6 text-sm font-semibold text-[#FF5800] transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ArrowRight className="h-4 w-4" />
                  )}
                  Connect
                </button>
              </div>
            </div>
          ) : cloudLoginUrl ? (
            <div className="flex w-full flex-col items-center gap-4">
              <p className="text-sm text-white/85">
                Finish signing in to Eliza Cloud in your browser.
              </p>
              <button
                type="button"
                data-testid="onboarding-cloud-open-signin"
                onClick={() => void openExternalUrl(cloudLoginUrl)}
                className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-white px-6 text-sm font-semibold text-[#FF5800] transition-opacity hover:opacity-90"
              >
                Open sign-in page
                <ArrowRight className="h-4 w-4" />
              </button>
              <p className="text-xs text-white/55">
                Waiting for you to finish sign-in…
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-lg font-semibold">
                Choose how to run your agent
              </h1>
              <div className="flex w-full flex-col gap-3">
                <OptionCard
                  testId="onboarding-option-cloud"
                  icon={Cloud}
                  title="Eliza Cloud"
                  subtitle="Hosted agent — nothing to set up"
                  badge="Recommended"
                  disabled={busy}
                  onClick={chooseCloud}
                />
                <OptionCard
                  testId="onboarding-option-remote"
                  icon={Server}
                  title="Remote server"
                  subtitle="Connect to your own running agent"
                  disabled={busy || cloudOnly}
                  onClick={chooseRemote}
                />
                <OptionCard
                  testId="onboarding-option-local"
                  icon={HardDrive}
                  title="Local models"
                  subtitle="Run on this device, fully private"
                  disabled={busy || cloudOnly}
                  onClick={chooseLocal}
                />
              </div>
            </>
          )}

          {statusMessage ? (
            <p className="min-h-5 text-sm leading-snug text-white/85">
              {statusMessage}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
