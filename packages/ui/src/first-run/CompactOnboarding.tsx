import {
  ArrowRight,
  ChevronLeft,
  Cloud,
  Cpu,
  Loader2,
  MailCheck,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import * as React from "react";
import { ElizaMark } from "../components/brand/eliza-mark";
import { getBootConfig } from "../config/boot-config-store";
import { TRAY_ACTION_EVENT } from "../events";
import { openExternalUrl } from "../utils/openExternalUrl";
import { AgentPicker } from "./AgentPicker";
import { trayActionToOnboardingChoice } from "./onboarding-intent";
import { useFirstRunController } from "./use-first-run-controller";

export function CompactOnboarding(): React.ReactElement {
  const c = useFirstRunController();
  const { busyText, cloudError, error, submitting, step, draft, cloudOnly } = c;
  const busy = submitting;
  // Brand wordmark from the active branding (whitelabel seam) — falls back to
  // the elizaOS name when no host branding is configured.
  const appName = getBootConfig().branding?.appName ?? "elizaOS";
  // Host-overridable brand glyph (whitelabel seam); falls back to ElizaMark.
  const BrandMark = getBootConfig().brandMark ?? ElizaMark;

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

  // Cloud-only hosts — the hosted app.elizacloud.ai web bundle and the
  // desktop/native "cloud" runtime builds — can ONLY run on Eliza Cloud: there
  // is no local / on-device choice to make, and therefore no inference
  // sub-choice either. Skip the "How should Eliza run?" picker entirely and hand
  // off straight to the cloud sign-in on first paint. The cloud-login flow's own
  // fallback surfaces a tappable "Open sign-in page" CTA if it cannot auto-open.
  const cloudOnlyAutoStarted = React.useRef(false);
  React.useEffect(() => {
    if (
      cloudOnly &&
      !cloudOnlyAutoStarted.current &&
      step === "runtime" &&
      !submitting
    ) {
      cloudOnlyAutoStarted.current = true;
      chooseCloud();
    }
  }, [cloudOnly, step, submitting, chooseCloud]);

  // Local runtime needs an inference sub-choice (cloud vs on-device) before it
  // can finish — advance to that step instead of provisioning immediately.
  const chooseLocal = React.useCallback(() => {
    c.updateDraft("runtime", "local");
    c.setStep("inference");
  }, [c]);

  // Local + cloud inference (recommended): the agent runs on this device but
  // routes inference through Eliza Cloud, so finishing kicks off the cloud
  // sign-in handoff when the account is not yet connected.
  const chooseCloudInference = React.useCallback(() => {
    c.updateDraft("localInference", "cloud-inference");
    void finishAndMaybeClose();
  }, [c, finishAndMaybeClose]);

  // Fully on-device inference: enabled everywhere, but slow/limited on phones.
  const chooseLocalInference = React.useCallback(() => {
    c.updateDraft("localInference", "all-local");
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
  // cloud error from a previous attempt must not shadow "Starting" etc. When
  // idle, surface the error (cloud login URLs render as a button below, so
  // they're excluded here).
  const statusMessage = busy
    ? busyText
    : (error ?? (cloudLoginUrl ? null : cloudError));

  const onRemote = step === "remote" && !cloudOnly;
  const onInference = step === "inference" && !cloudOnly;

  return (
    <div className="first-run-screen pointer-events-none fixed inset-0 p-6 text-white">
      <div className="mx-auto flex h-full w-full max-w-[24rem] flex-col items-center justify-start pt-[calc(var(--safe-area-top,0px)+3rem)] text-center">
        <div
          data-testid="onboarding-toast"
          className="pointer-events-auto flex w-full flex-col items-center gap-8"
        >
          <div className="flex w-full flex-col items-center gap-8 motion-safe:animate-[shell-overlay-in_220ms_ease-out]">
            {/* Brand lockup — matches the loading screen for visual continuity. */}
            <div className="flex items-center justify-center gap-3">
              <BrandMark className="h-11 w-11" />
              <span className="text-3xl font-medium leading-none tracking-normal">
                {appName}
              </span>
            </div>

            {onRemote ? (
              // ADVANCED — connect to a self-run setup. Reachable only via the
              // demoted "Advanced setup" link, with gentle, plain-language copy.
              <div className="flex w-full flex-col gap-5">
                <h1 className="text-center text-[20px] font-semibold tracking-[-0.01em]">
                  Connect your own agent
                </h1>
                <div className="flex flex-col gap-1.5 text-left">
                  <label
                    htmlFor="onboarding-remote-address"
                    className="text-[12px] font-medium text-white/70"
                  >
                    Server address
                  </label>
                  <input
                    id="onboarding-remote-address"
                    // biome-ignore lint/a11y/noAutofocus: first field of an intentional form step
                    autoFocus
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={draft.remoteApiBase}
                    onChange={(e) =>
                      c.updateDraft("remoteApiBase", e.target.value)
                    }
                    placeholder="https://agent.example.com"
                    className="w-full rounded-xl border border-white/25 bg-white/10 px-4 py-3 text-[15px] text-white outline-none transition-colors placeholder:text-white/40 focus:border-white/70 focus:bg-white/[0.14]"
                  />
                </div>
                <div className="flex flex-col gap-1.5 text-left">
                  <label
                    htmlFor="onboarding-remote-password"
                    className="text-[12px] font-medium text-white/70"
                  >
                    Password
                  </label>
                  <input
                    id="onboarding-remote-password"
                    type="password"
                    value={draft.remoteToken}
                    onChange={(e) =>
                      c.updateDraft("remoteToken", e.target.value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void finishAndMaybeClose();
                    }}
                    placeholder="Optional"
                    className="w-full rounded-xl border border-white/25 bg-white/10 px-4 py-3 text-[15px] text-white outline-none transition-colors placeholder:text-white/40 focus:border-white/70 focus:bg-white/[0.14]"
                  />
                </div>
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
                    className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-6 text-[15px] font-semibold text-[#FF5800] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35)] transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-50 motion-reduce:active:scale-100"
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
              // CLOUD SIGN-IN handoff — finish in the browser, then come back.
              <div className="flex w-full flex-col items-center gap-5">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/[0.12]">
                  <MailCheck className="h-6 w-6" />
                </span>
                <h1 className="text-[18px] font-semibold">
                  Sign in to Eliza Cloud
                </h1>
                <button
                  type="button"
                  data-testid="onboarding-cloud-open-signin"
                  onClick={() => void openExternalUrl(cloudLoginUrl)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-6 text-[15px] font-semibold text-[#FF5800] transition-opacity hover:opacity-90"
                >
                  Open sign-in page
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            ) : step === "pick-agent" ? (
              // PICK AGENT — after cloud sign-in, when the user already has cloud
              // agents, choose an existing one or create a new one.
              <AgentPicker
                agents={c.pickerAgents}
                activeAgentId={c.pickerActiveAgentId}
                phase={c.pickerPhase}
                errorMessage={c.pickerError}
                bindingAgentId={c.pickerBindingId}
                onPick={c.onPickAgent}
                onCreateNew={c.onCreateNewAgent}
                onRetry={c.onRetryPicker}
                onBack={c.onBackFromPicker}
              />
            ) : onInference ? (
              // INFERENCE — after picking the on-device agent, choose where it
              // thinks: Eliza Cloud (recommended — fast, best models) or fully
              // on-device (kept for privacy/offline, but slow and limited on
              // phones). Picking cloud finishes via the sign-in handoff above.
              <div className="flex w-full flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">
                    Where should it think?
                  </h1>
                  <p className="text-[13px] leading-snug text-white/70">
                    Your agent runs on this device. Choose where it runs its AI.
                  </p>
                </div>
                <div className="flex w-full flex-col gap-3">
                  {/* PRIMARY — cloud inference (recommended). */}
                  <button
                    type="button"
                    data-testid="onboarding-inference-cloud"
                    disabled={busy}
                    onClick={chooseCloudInference}
                    className="group flex w-full items-center gap-3.5 rounded-2xl bg-white px-5 py-4 text-left shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35)] transition-[transform,box-shadow,opacity] duration-200 ease-out hover:shadow-[0_12px_30px_-8px_rgba(0,0,0,0.45)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#FF5800]/10">
                      <Cloud className="h-5 w-5 text-[#FF5800]" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="text-[16px] font-semibold leading-tight text-[#FF5800]">
                          Cloud inference
                        </span>
                        <span className="rounded-full bg-[#FF5800]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#FF5800]">
                          Recommended
                        </span>
                      </span>
                      <span className="text-[12px] leading-snug text-black/55">
                        Fast, runs the best models. Sign in to Eliza Cloud.
                      </span>
                    </span>
                    <ArrowRight className="h-5 w-5 shrink-0 text-[#FF5800]/60 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" />
                  </button>

                  {/* SECONDARY — fully on-device inference. */}
                  <button
                    type="button"
                    data-testid="onboarding-inference-local"
                    disabled={busy}
                    onClick={chooseLocalInference}
                    className="group flex w-full items-center gap-3.5 rounded-2xl border border-white/20 bg-white/[0.08] px-5 py-4 text-left backdrop-blur-sm transition-colors duration-200 hover:bg-white/[0.14] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:scale-100"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.12]">
                      <Cpu className="h-5 w-5 text-white/90" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="text-[15px] font-semibold leading-tight">
                          On-device inference
                        </span>
                        <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white/60">
                          Offline
                        </span>
                      </span>
                      <span className="text-[12px] leading-snug text-white/55">
                        Private and offline. Slower, and limited on phones.
                      </span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                  </button>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => c.setStep("runtime")}
                  className="mx-auto inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/10 disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </button>
              </div>
            ) : (
              // WELCOME / CHOICE — one warm headline, one obvious primary action,
              // a clear private alternative, and the technical path demoted to a
              // quiet link so a first-timer never sees jargon.
              <>
                <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">
                  How should {appName} run?
                </h1>
                <div className="mt-1 flex w-full flex-col gap-3">
                  {/* PRIMARY — the simplest "just start" path (cloud). */}
                  <button
                    type="button"
                    data-testid="onboarding-option-cloud"
                    disabled={busy}
                    onClick={chooseCloud}
                    className="group flex w-full items-center gap-3.5 rounded-2xl bg-white px-5 py-4 text-left shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35)] transition-[transform,box-shadow,opacity] duration-200 ease-out hover:shadow-[0_12px_30px_-8px_rgba(0,0,0,0.45)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#FF5800]/10">
                      <Cloud className="h-5 w-5 text-[#FF5800]" />
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="text-[17px] font-semibold leading-tight text-[#FF5800]">
                        Eliza Cloud
                      </span>
                      <span className="rounded-full bg-[#FF5800]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#FF5800]">
                        Recommended
                      </span>
                    </span>
                    <ArrowRight className="h-5 w-5 shrink-0 text-[#FF5800]/60 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none" />
                  </button>

                  {/* SECONDARY — private / on this device. Always rendered (it is
                      disabled, never unmounted, in cloud-only builds). */}
                  <button
                    type="button"
                    data-testid="onboarding-option-local"
                    disabled={busy || cloudOnly}
                    onClick={chooseLocal}
                    className={`group flex w-full items-center gap-3.5 rounded-2xl border border-white/20 bg-white/[0.08] px-5 py-4 text-left backdrop-blur-sm transition-colors duration-200 hover:bg-white/[0.14] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:scale-100 ${cloudOnly ? "hidden" : ""}`}
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.12]">
                      <ShieldCheck className="h-5 w-5 text-white/90" />
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="text-[15px] font-semibold leading-tight">
                        This device
                      </span>
                      <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white/60">
                        Private
                      </span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                  </button>

                  {/* TERTIARY — the technical path, demoted to a quiet link. Kept
                      always-present (testid + handler stable) so it stays
                      reachable for power users. */}
                  {!cloudOnly ? (
                    <button
                      type="button"
                      data-testid="onboarding-option-remote"
                      disabled={busy}
                      onClick={chooseRemote}
                      className="mx-auto mt-1 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white/85 disabled:opacity-40"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      Advanced
                    </button>
                  ) : null}
                </div>
              </>
            )}

            {statusMessage ? (
              // Announce progress/error changes to screen readers (TalkBack) —
              // polite, since this is the shared progress + error status node.
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="min-h-5 text-sm leading-snug text-white/85"
              >
                {statusMessage}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
