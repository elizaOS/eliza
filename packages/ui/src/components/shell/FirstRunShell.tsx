import {
  ArrowLeft,
  Check,
  Cloud,
  HardDrive,
  Loader2,
  Mic,
  MicOff,
  Network,
  Settings2,
  Volume2,
} from "lucide-react";
import * as React from "react";
import {
  type FirstRunDraftUpdate,
  type FirstRunLocalInference,
  type FirstRunProfileDraft,
  type FirstRunStep,
  normalizeFirstRunName,
} from "../../first-run/first-run";
import type { MicrophonePermissionController } from "../../first-run/use-microphone-permission";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext.hooks";
import { StatusBadge } from "../ui/status-badge";

type TranslateFn = TranslationContextValue["t"];

const GLASS_INTERACTIVE =
  "border-[var(--first-run-card-border)] bg-[var(--first-run-card-bg)] text-[var(--first-run-text-primary)] hover:bg-[var(--first-run-card-bg-hover)]";
const GLASS_PANEL =
  "border-[var(--first-run-card-border)] bg-[var(--first-run-card-bg)] text-[var(--first-run-text-muted)]";

export interface FirstRunShellProps {
  step: FirstRunStep;
  draft: FirstRunProfileDraft;
  localRuntimeAvailable: boolean;
  cloudOnly: boolean;
  elizaCloudConnected: boolean;
  submitting: boolean;
  busyText: string | null;
  error: string | null;
  cloudError: string | null | undefined;
  voice: {
    supported: boolean;
    listening: boolean;
    speaking: boolean;
    transcript: string;
    error: string | null;
  };
  microphone: MicrophonePermissionController;
  primaryLabel: string;
  canBack: boolean;
  updateDraft: FirstRunDraftUpdate;
  setStep: (step: FirstRunStep) => void;
  goBack: () => void;
  finishRuntime: () => void;
  toggleVoice: () => Promise<void>;
  onPromptReady: (promptText: string, lineId: string) => void;
}

function RuntimeCard(props: {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  detail: string;
  badge?: string;
  /** When set, renders a green "connected" status chip alongside the badge. */
  connectedLabel?: string;
  emphasis?: "primary" | "muted";
  testId: string;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  const Icon = props.icon;
  const muted = props.emphasis === "muted";
  return (
    <div
      className={[
        "w-full rounded-md border text-left transition",
        props.active
          ? "border-[#0B35F1] bg-[var(--first-run-card-bg-hover)]"
          : GLASS_INTERACTIVE,
      ].join(" ")}
    >
      <button
        type="button"
        onClick={props.onClick}
        aria-pressed={props.active}
        data-testid={props.testId}
        className={[
          "flex w-full items-start gap-3 px-4",
          muted ? "py-3" : "py-4",
        ].join(" ")}
      >
        <Icon
          className={[
            "mt-0.5 shrink-0",
            muted ? "h-4 w-4 text-[var(--first-run-text-muted)]" : "h-5 w-5",
            props.active ? "text-[#0B35F1]" : "",
          ].join(" ")}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span
              className={[
                "font-semibold",
                muted
                  ? "text-sm text-[var(--first-run-text-muted)]"
                  : "text-base text-[var(--first-run-text-primary)]",
              ].join(" ")}
            >
              {props.label}
            </span>
            {props.badge || props.connectedLabel ? (
              <span className="ml-auto flex items-center gap-1.5">
                {props.connectedLabel ? (
                  <StatusBadge
                    label={props.connectedLabel}
                    variant="success"
                    withDot
                  />
                ) : null}
                {props.badge ? (
                  <StatusBadge
                    label={props.badge}
                    variant="muted"
                    className={
                      props.emphasis === "primary"
                        ? "border-[#0B35F1]/40 bg-[#0B35F1]/10 text-[#0B35F1]"
                        : undefined
                    }
                  />
                ) : null}
              </span>
            ) : null}
          </span>
          <span className="text-xs leading-relaxed text-[var(--first-run-text-muted)]">
            {props.detail}
          </span>
        </span>
      </button>
      {props.children ? (
        <div className="border-t border-[var(--first-run-card-border)] px-4 py-3">
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

function LocalInferenceChoice(props: {
  value: FirstRunLocalInference;
  onChange: (value: FirstRunLocalInference) => void;
  t: TranslateFn;
}) {
  const { t } = props;
  const options: ReadonlyArray<{
    value: FirstRunLocalInference;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    detail: string;
  }> = [
    {
      value: "all-local",
      icon: HardDrive,
      label: t("firstrunshell.allLocalLabel", {
        defaultValue: "All local models",
      }),
      detail: t("firstrunshell.allLocalDetail", {
        defaultValue: "Everything runs on-device.",
      }),
    },
    {
      value: "cloud-inference",
      icon: Cloud,
      label: t("firstrunshell.cloudInferenceLabel", {
        defaultValue: "Connect Eliza Cloud",
      }),
      detail: t("firstrunshell.cloudInferenceDetail", {
        defaultValue: "Inference via Eliza Cloud.",
      }),
    },
  ];
  return (
    <div
      className="flex flex-col gap-2"
      role="radiogroup"
      aria-label={t("firstrunshell.localInferenceLabel", {
        defaultValue: "Local inference",
      })}
    >
      {options.map((option) => {
        const active = props.value === option.value;
        const Icon = option.icon;
        return (
          <label
            key={option.value}
            className={[
              "flex cursor-pointer items-center gap-3 rounded-sm border px-3 py-2 text-left transition",
              active
                ? "border-[#0B35F1] bg-[#0B35F1]/10"
                : "border-[var(--first-run-card-border)] hover:bg-[var(--first-run-card-bg-hover)]",
            ].join(" ")}
          >
            <input
              type="radio"
              name="first-run-local-mode"
              checked={active}
              data-testid={`first-run-local-${option.value}`}
              onChange={() => props.onChange(option.value)}
              className="sr-only"
            />
            <Icon
              className={[
                "h-4 w-4 shrink-0",
                active
                  ? "text-[#0B35F1]"
                  : "text-[var(--first-run-text-muted)]",
              ].join(" ")}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-semibold text-[var(--first-run-text-primary)]">
                {option.label}
              </span>
              <span className="text-xs text-[var(--first-run-text-muted)]">
                {option.detail}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function GlassButton(props: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  variant?: "primary" | "secondary";
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={[
        "inline-flex min-h-[3rem] min-w-[7rem] items-center justify-center gap-2 rounded-sm border px-5 py-3 text-sm font-semibold transition disabled:pointer-events-none disabled:opacity-45",
        props.variant === "primary"
          ? "border-[#0B35F1] bg-[#0B35F1] text-white hover:bg-[#082ed6]"
          : GLASS_INTERACTIVE,
      ].join(" ")}
    >
      {Icon ? (
        <Icon
          className={["h-4 w-4", Icon === Loader2 ? "animate-spin" : ""].join(
            " ",
          )}
        />
      ) : null}
      {props.children}
    </button>
  );
}

function BareInput(props: {
  autoFocus?: boolean;
  placeholder: string;
  type?: React.HTMLInputTypeAttribute;
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  compact?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (props.autoFocus) inputRef.current?.focus();
  }, [props.autoFocus]);

  return (
    <input
      ref={inputRef}
      autoComplete="off"
      type={props.type ?? "text"}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") props.onEnter?.();
      }}
      placeholder={props.placeholder}
      className={[
        "w-full border-0 border-b-2 border-border bg-transparent px-2 pb-3 text-center font-medium text-txt outline-none placeholder:text-muted focus:border-[#0B35F1]",
        props.compact ? "text-2xl" : "text-4xl",
      ].join(" ")}
    />
  );
}

function promptForStep(
  step: FirstRunStep,
  agentNameValue: string,
  t: TranslateFn,
): string {
  const agentName = normalizeFirstRunName(agentNameValue) || "Eliza";
  if (step === "remote")
    return t("firstrunshell.promptRemote", {
      defaultValue: "Where is the remote agent?",
    });
  return t("firstrunshell.promptRuntime", {
    agentName,
    defaultValue: "Where should {{agentName}} run?",
  });
}

function useTypedPrompt(text: string): { rendered: string; complete: boolean } {
  const [rendered, setRendered] = React.useState("");
  const [complete, setComplete] = React.useState(false);

  React.useEffect(() => {
    // Respect prefers-reduced-motion: render the full prompt instantly instead
    // of animating it character by character.
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setRendered(text);
      setComplete(true);
      return;
    }

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const characters = Array.from(text);
    setRendered("");
    setComplete(false);

    // Drive the reveal off elapsed wall-clock time rather than counting one
    // character per timer tick. Under main-thread contention (animation work
    // plus this hook re-rendering the whole shell on every character) the
    // chained timers fire hundreds of ms apart instead of ~20ms,
    // which previously stretched a ~0.6s animation to ~18s and left the heading
    // mid-word for seconds. Catching up to the time-derived index keeps the
    // total reveal bounded by REVEAL_DURATION_MS no matter how starved the
    // event loop is, so the completed prompt is always available promptly.
    const REVEAL_DURATION_MS = 600;
    const STEP_MS = 22;
    const startedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    const reveal = () => {
      if (cancelled) return;
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      const progress = Math.min(1, (now - startedAt) / REVEAL_DURATION_MS);
      const index = Math.max(1, Math.ceil(progress * characters.length));
      if (progress >= 1 || index >= characters.length) {
        setRendered(text);
        setComplete(true);
        return;
      }
      setRendered(characters.slice(0, index).join(""));
      timeout = setTimeout(reveal, STEP_MS);
    };

    timeout = setTimeout(reveal, STEP_MS);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [text]);

  return { rendered, complete };
}

function FirstRunStatus(props: {
  busyText: string | null;
  error: string | null;
  cloudError: string | null | undefined;
}) {
  if (props.busyText) {
    return (
      <p
        className={`inline-flex min-h-[2.5rem] items-center justify-center gap-2 rounded-sm border px-4 py-2 text-sm ${GLASS_PANEL}`}
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {props.busyText}
      </p>
    );
  }
  const message = props.error ?? props.cloudError;
  if (!message) return <div className="min-h-[2.5rem]" />;
  return (
    <p className="max-w-[40rem] rounded-sm border border-destructive/40 bg-destructive-subtle px-4 py-2 text-center text-sm text-destructive">
      {message}
    </p>
  );
}

function FirstRunMicrophonePermission(props: {
  microphone: MicrophonePermissionController;
  t: TranslateFn;
}) {
  const { microphone, t } = props;
  const { status, canRequest, requesting } = microphone;

  if (status === "granted") {
    return (
      <div className="flex min-h-[2.75rem] items-center justify-center">
        <StatusBadge
          label={t("firstrunshell.micGranted", {
            defaultValue: "Microphone ready",
          })}
          variant="success"
          icon={<Mic />}
          withDot
        />
      </div>
    );
  }

  // `not-applicable` means the renderer has no microphone API at all (e.g. a
  // headless surface) — there is nothing actionable to show.
  if (status === "not-applicable") {
    return null;
  }

  const denied =
    status === "denied" || status === "restricted" || canRequest === false;

  return (
    <div className="flex min-h-[2.75rem] w-full flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => {
          void (denied ? microphone.openSettings() : microphone.request());
        }}
        disabled={requesting}
        data-testid={
          denied
            ? "first-run-microphone-open-settings"
            : "first-run-microphone-request"
        }
        className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border px-4 py-2 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-45 ${GLASS_INTERACTIVE}`}
      >
        {requesting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : denied ? (
          <Settings2 className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
        {requesting
          ? t("firstrunshell.micRequesting", { defaultValue: "Requesting…" })
          : denied
            ? t("firstrunshell.micOpenSettings", {
                defaultValue: "Open Settings",
              })
            : t("firstrunshell.micEnable", {
                defaultValue: "Enable microphone",
              })}
      </button>
      {denied ? (
        <p className="max-w-[24rem] text-center text-xs text-[var(--first-run-text-muted)]">
          {t("firstrunshell.micDeniedHelp", {
            defaultValue: "Microphone blocked — enable it in settings.",
          })}
        </p>
      ) : null}
    </div>
  );
}

function FirstRunVoiceControl(props: {
  voice: FirstRunShellProps["voice"];
  toggleVoice: () => Promise<void>;
  t: TranslateFn;
}) {
  const { t } = props;
  const state = props.voice.speaking
    ? "speaking"
    : props.voice.listening
      ? "listening"
      : "idle";
  const label =
    state === "speaking"
      ? t("firstrunshell.voiceSpeaking", { defaultValue: "Speaking" })
      : state === "listening"
        ? t("firstrunshell.voiceListening", { defaultValue: "Listening" })
        : t("firstrunshell.voiceNotListening", {
            defaultValue: "Not listening",
          });
  const detail = props.voice.error ?? props.voice.transcript;

  return (
    <div className="flex min-h-[2.75rem] flex-wrap items-center justify-center gap-3 text-muted">
      <button
        type="button"
        onClick={() => {
          void props.toggleVoice();
        }}
        aria-pressed={props.voice.listening}
        aria-label={
          props.voice.listening
            ? t("firstrunshell.stopVoice", {
                defaultValue: "Stop voice input",
              })
            : t("firstrunshell.startVoice", {
                defaultValue: "Start voice input",
              })
        }
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-transparent px-1 py-2 transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0B35F1]"
      >
        <StatusBadge
          label={label}
          variant={state === "listening" ? "success" : "muted"}
          className={
            state === "speaking"
              ? "border-[#0B35F1]/35 bg-[#0B35F1]/10 text-[#0B35F1]"
              : undefined
          }
          pulse={state === "listening"}
          withDot={state === "listening"}
          icon={
            state === "speaking" ? (
              <Volume2 />
            ) : state === "idle" ? (
              <MicOff />
            ) : undefined
          }
        />
      </button>
      {detail ? (
        <p className="max-w-[30rem] text-center text-sm font-medium">
          {detail}
        </p>
      ) : null}
    </div>
  );
}

function FirstRunControls(props: {
  step: FirstRunStep;
  draft: FirstRunProfileDraft;
  localRuntimeAvailable: boolean;
  cloudOnly: boolean;
  elizaCloudConnected: boolean;
  submitting: boolean;
  primaryLabel: string;
  updateDraft: FirstRunDraftUpdate;
  setStep: (step: FirstRunStep) => void;
  finishRuntime: () => void;
  t: TranslateFn;
}) {
  const { t } = props;
  if (props.step === "remote" && !props.cloudOnly) {
    return (
      <div className="grid w-full gap-5">
        <BareInput
          autoFocus
          compact
          value={props.draft.remoteApiBase}
          onChange={(value) => props.updateDraft("remoteApiBase", value)}
          placeholder="https://agent.example.com"
        />
        <BareInput
          compact
          value={props.draft.remoteToken}
          onChange={(value) => props.updateDraft("remoteToken", value)}
          onEnter={props.finishRuntime}
          placeholder={t("firstrunshell.accessTokenPlaceholder", {
            defaultValue: "Access token",
          })}
          type="password"
        />
        <div className="flex flex-wrap items-center justify-center gap-3">
          <GlassButton
            variant="secondary"
            disabled={props.submitting}
            onClick={() => props.setStep("runtime")}
          >
            {t("firstrunshell.runtime", { defaultValue: "Runtime" })}
          </GlassButton>
          <GlassButton
            variant="primary"
            disabled={props.submitting}
            icon={props.submitting ? Loader2 : Check}
            onClick={props.finishRuntime}
          >
            {props.submitting
              ? t("firstrunshell.working", { defaultValue: "Working" })
              : props.primaryLabel}
          </GlassButton>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex w-full flex-col gap-3">
        <RuntimeCard
          active={props.draft.runtime === "cloud"}
          icon={Cloud}
          label={t("firstrunshell.cloudLabel", { defaultValue: "Cloud" })}
          badge={t("firstrunshell.recommended", {
            defaultValue: "Recommended",
          })}
          connectedLabel={
            props.elizaCloudConnected
              ? t("firstrunshell.connected", { defaultValue: "Connected" })
              : undefined
          }
          emphasis="primary"
          testId="first-run-runtime-cloud"
          detail={t("firstrunshell.cloudDetail", {
            defaultValue: "Always on, runs 24/7.",
          })}
          onClick={() => props.updateDraft("runtime", "cloud")}
        />

        {props.localRuntimeAvailable ? (
          <RuntimeCard
            active={props.draft.runtime === "local"}
            icon={HardDrive}
            label={t("firstrunshell.localLabel", { defaultValue: "Local" })}
            badge={t("firstrunshell.advanced", { defaultValue: "Advanced" })}
            testId="first-run-runtime-local"
            detail={t("firstrunshell.localDetail", {
              defaultValue: "Runs on your machine.",
            })}
            onClick={() => {
              const wasLocal = props.draft.runtime === "local";
              props.updateDraft("runtime", "local");
              if (
                !wasLocal &&
                props.draft.localInference === "cloud-inference"
              ) {
                props.updateDraft("localInference", "all-local");
              }
            }}
          >
            {props.draft.runtime === "local" ? (
              <LocalInferenceChoice
                value={props.draft.localInference}
                onChange={(value) => props.updateDraft("localInference", value)}
                t={t}
              />
            ) : null}
          </RuntimeCard>
        ) : null}

        {props.cloudOnly ? null : (
          <RuntimeCard
            active={props.draft.runtime === "remote"}
            icon={Network}
            label={t("firstrunshell.useAsRemote", {
              defaultValue: "Use as remote",
            })}
            emphasis="muted"
            testId="first-run-runtime-remote"
            detail={t("firstrunshell.useAsRemoteDetail", {
              defaultValue: "Connect from another device.",
            })}
            onClick={() => {
              props.updateDraft("runtime", "remote");
              props.setStep("remote");
            }}
          />
        )}
      </div>
      <GlassButton
        variant="primary"
        disabled={props.submitting}
        icon={props.submitting ? Loader2 : Check}
        onClick={props.finishRuntime}
      >
        {props.submitting
          ? t("firstrunshell.working", { defaultValue: "Working" })
          : props.primaryLabel}
      </GlassButton>
    </div>
  );
}

export function FirstRunShell({
  step,
  draft,
  localRuntimeAvailable,
  cloudOnly,
  elizaCloudConnected,
  submitting,
  busyText,
  error,
  cloudError,
  voice,
  microphone,
  primaryLabel,
  canBack,
  updateDraft,
  setStep,
  goBack,
  finishRuntime,
  toggleVoice,
  onPromptReady,
}: FirstRunShellProps) {
  const { t } = useTranslation();
  const promptText = React.useMemo(
    () => promptForStep(step, draft.agentName, t),
    [draft.agentName, step, t],
  );
  const { rendered: renderedPrompt, complete: promptComplete } =
    useTypedPrompt(promptText);

  // `onPromptReady` has an unstable identity, so fire it through a ref and key
  // the effect on the prompt text only — once per completed prompt.
  const onPromptReadyRef = React.useRef(onPromptReady);
  onPromptReadyRef.current = onPromptReady;
  React.useEffect(() => {
    // `step` doubles as the onboarding voice-line id (see ONBOARDING_VOICE_LINES).
    if (promptComplete) onPromptReadyRef.current(promptText, step);
  }, [promptComplete, promptText, step]);

  return (
    <div
      data-testid="first-run-shell"
      className="first-run-screen relative flex min-h-[100dvh] w-full overflow-hidden bg-[#F7F9FF] text-[#0B35F1]"
    >
      <div className="relative z-10 flex min-h-[100dvh] w-full flex-col px-4 py-4 sm:px-6 sm:py-6">
        <div className="flex h-12 items-center">
          {canBack ? (
            <button
              type="button"
              onClick={goBack}
              className={`inline-flex h-11 w-11 items-center justify-center rounded-sm border transition ${GLASS_INTERACTIVE}`}
              aria-label={t("firstrunshell.back", { defaultValue: "Back" })}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : null}
        </div>

        <div className="mx-auto flex w-full max-w-[42rem] flex-1 flex-col items-center justify-center gap-8 pb-[8vh] pt-6">
          <h1 className="min-h-[5rem] max-w-[34rem] text-balance text-center text-3xl font-semibold leading-tight tracking-tight text-txt sm:min-h-[6rem] sm:text-5xl">
            {renderedPrompt}
            {!promptComplete ? <span aria-hidden="true">|</span> : null}
          </h1>

          <div
            className={[
              "flex min-h-[12rem] w-full max-w-[30rem] flex-col items-center justify-center gap-6 transition duration-300",
              promptComplete
                ? "translate-y-0 opacity-100"
                : "translate-y-2 opacity-0",
            ].join(" ")}
            aria-hidden={!promptComplete}
          >
            {promptComplete ? (
              <FirstRunControls
                step={step}
                draft={draft}
                localRuntimeAvailable={localRuntimeAvailable}
                cloudOnly={cloudOnly}
                elizaCloudConnected={elizaCloudConnected}
                submitting={submitting}
                primaryLabel={primaryLabel}
                updateDraft={updateDraft}
                setStep={setStep}
                finishRuntime={finishRuntime}
                t={t}
              />
            ) : null}
            {promptComplete && step === "runtime" ? (
              <FirstRunMicrophonePermission microphone={microphone} t={t} />
            ) : null}
            {promptComplete ? (
              <FirstRunVoiceControl
                voice={voice}
                toggleVoice={toggleVoice}
                t={t}
              />
            ) : null}
            <FirstRunStatus
              busyText={busyText}
              error={error}
              cloudError={cloudError}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
