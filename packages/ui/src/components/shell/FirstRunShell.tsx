import {
  ArrowLeft,
  Check,
  Cloud,
  HardDrive,
  Loader2,
  Network,
} from "lucide-react";
import * as React from "react";
import {
  type FirstRunDraftUpdate,
  type FirstRunLocalInference,
  type FirstRunProfileDraft,
  type FirstRunStep,
  normalizeFirstRunName,
} from "../../first-run/first-run";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext";
import { Checkbox } from "../ui/checkbox";

type TranslateFn = TranslationContextValue["t"];

const GLASS_INTERACTIVE =
  "border-[var(--first-run-card-border)] bg-[var(--first-run-card-bg)] text-[var(--first-run-text-primary)] hover:bg-[var(--first-run-card-bg-hover)]";
const GLASS_PANEL =
  "border-[var(--first-run-card-border)] bg-[var(--first-run-card-bg)] text-[var(--first-run-text-muted)]";

export interface FirstRunShellProps {
  step: FirstRunStep;
  draft: FirstRunProfileDraft;
  localRuntimeAvailable: boolean;
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
          ? "border-accent bg-[var(--first-run-card-bg-hover)]"
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
            props.active ? "text-accent" : "",
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
            {props.badge ? (
              <span
                className={[
                  "ml-auto rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide",
                  props.emphasis === "primary"
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-[var(--first-run-card-border)] text-[var(--first-run-text-muted)]",
                ].join(" ")}
              >
                {props.badge}
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
    label: string;
    detail: string;
  }> = [
    {
      value: "all-local",
      label: t("firstrunshell.allLocalLabel", {
        defaultValue: "All local models",
      }),
      detail: t("firstrunshell.allLocalDetail", {
        defaultValue: "Download and run everything on this machine.",
      }),
    },
    {
      value: "cloud-inference",
      label: t("firstrunshell.cloudInferenceLabel", {
        defaultValue: "Connect Eliza Cloud",
      }),
      detail: t("firstrunshell.cloudInferenceDetail", {
        defaultValue:
          "Keep the agent local, route inference through the cloud.",
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
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`first-run-local-${option.value}`}
            onClick={() => props.onChange(option.value)}
            className={[
              "flex flex-col gap-0.5 rounded-sm border px-3 py-2 text-left transition",
              active
                ? "border-accent bg-accent/10"
                : "border-[var(--first-run-card-border)] hover:bg-[var(--first-run-card-bg-hover)]",
            ].join(" ")}
          >
            <span className="text-sm font-semibold text-[var(--first-run-text-primary)]">
              {option.label}
            </span>
            <span className="text-xs text-[var(--first-run-text-muted)]">
              {option.detail}
            </span>
          </button>
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
          ? "border-accent bg-accent text-accent-foreground hover:bg-accent-hover"
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
        "w-full border-0 border-b-2 border-border bg-transparent px-2 pb-3 text-center font-medium text-txt outline-none placeholder:text-muted focus:border-accent",
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
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const characters = Array.from(text);
    let index = 0;
    setRendered("");
    setComplete(false);

    const reveal = () => {
      if (cancelled) return;
      index += 1;
      setRendered(characters.slice(0, index).join(""));
      if (index >= characters.length) {
        setComplete(true);
        return;
      }
      const previous = characters[index - 1];
      timeout = setTimeout(reveal, previous === " " ? 12 : 22);
    };

    timeout = setTimeout(reveal, 40);
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

function FirstRunVoiceControl(props: {
  voice: FirstRunShellProps["voice"];
  toggleVoice: () => Promise<void>;
  t: TranslateFn;
}) {
  const { t } = props;
  const buttonLabel = props.voice.speaking
    ? t("firstrunshell.voiceSpeaking", { defaultValue: "Speaking" })
    : props.voice.listening
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
        className="inline-flex min-h-11 min-w-[8.5rem] items-center justify-center bg-transparent px-2 py-2 text-sm font-semibold text-txt transition hover:text-accent focus-visible:outline-none focus-visible:underline"
      >
        {buttonLabel}
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
  elizaCloudConnected: boolean;
  submitting: boolean;
  primaryLabel: string;
  updateDraft: FirstRunDraftUpdate;
  setStep: (step: FirstRunStep) => void;
  finishRuntime: () => void;
  t: TranslateFn;
}) {
  const { t } = props;
  if (props.step === "remote") {
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
          emphasis="primary"
          testId="first-run-runtime-cloud"
          detail={
            props.elizaCloudConnected
              ? t("firstrunshell.cloudDetailConnected", {
                  defaultValue:
                    "Runs 24/7 persistent agents that never sleep. Account connected.",
                })
              : t("firstrunshell.cloudDetail", {
                  defaultValue: "Runs 24/7 persistent agents that never sleep.",
                })
          }
          onClick={() => props.updateDraft("runtime", "cloud")}
        />

        {props.localRuntimeAvailable ? (
          <RuntimeCard
            active={
              props.draft.runtime === "local" &&
              props.draft.localInference === "all-local"
            }
            icon={HardDrive}
            label={t("firstrunshell.localLabel", { defaultValue: "Local" })}
            badge={t("firstrunshell.advanced", { defaultValue: "Advanced" })}
            testId="first-run-runtime-local"
            detail={t("firstrunshell.localDetail", {
              defaultValue:
                "Runs on your machine. Use local inference or connect Eliza Cloud.",
            })}
            onClick={() => props.updateDraft("runtime", "local")}
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

        {props.draft.runtime === "cloud" ? (
          <div
            className={`flex items-center gap-2 rounded-sm border px-4 py-2 text-sm ${GLASS_PANEL}`}
          >
            <Checkbox
              aria-label={t("firstrunshell.keepEmbeddingsLocal", {
                defaultValue: "Keep embeddings local",
              })}
              checked={props.draft.useLocalEmbeddings}
              onCheckedChange={(checked) =>
                props.updateDraft("useLocalEmbeddings", checked === true)
              }
            />
            <span>
              {t("firstrunshell.keepEmbeddingsLocal", {
                defaultValue: "Keep embeddings local",
              })}
            </span>
          </div>
        ) : null}

        <RuntimeCard
          active={props.draft.runtime === "remote"}
          icon={Network}
          label={t("firstrunshell.useAsRemote", {
            defaultValue: "Use as remote",
          })}
          emphasis="muted"
          testId="first-run-runtime-remote"
          detail={t("firstrunshell.useAsRemoteDetail", {
            defaultValue: "Connect to your local machine from another device.",
          })}
          onClick={() => {
            props.updateDraft("runtime", "remote");
            props.setStep("remote");
          }}
        />
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
  elizaCloudConnected,
  submitting,
  busyText,
  error,
  cloudError,
  voice,
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

  // `onPromptReady` calls setVoice, which re-renders this component. Its
  // identity is unstable (it ultimately derives from app-context callbacks like
  // completeFirstRun, which change when first-run state churns during agent
  // start). Depending on it here would re-fire the effect on every such render,
  // re-entering setVoice → re-render → infinite loop that freezes onboarding.
  // The intent is "fire once when the typed prompt finishes, keyed on its
  // text", so call the latest handler through a ref and gate on the prompt.
  const onPromptReadyRef = React.useRef(onPromptReady);
  onPromptReadyRef.current = onPromptReady;
  React.useEffect(() => {
    // `step` doubles as the onboarding voice-line id (see ONBOARDING_VOICE_LINES).
    if (promptComplete) onPromptReadyRef.current(promptText, step);
  }, [promptComplete, promptText, step]);

  return (
    <div
      data-testid="first-run-shell"
      className="first-run-screen relative flex min-h-[100dvh] w-full overflow-hidden bg-bg text-txt"
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
                elizaCloudConnected={elizaCloudConnected}
                submitting={submitting}
                primaryLabel={primaryLabel}
                updateDraft={updateDraft}
                setStep={setStep}
                finishRuntime={finishRuntime}
                t={t}
              />
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
