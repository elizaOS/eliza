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
  type FirstRunProfileDraft,
  type FirstRunRuntime,
  type FirstRunStep,
  normalizeFirstRunName,
} from "../../first-run/first-run";
import { Checkbox } from "../ui/checkbox";

export interface FirstRunShellProps {
  step: FirstRunStep;
  draft: FirstRunProfileDraft;
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
  onPromptReady: (promptText: string) => void;
}

function RuntimeButton(props: {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={[
        "inline-flex min-h-[3.25rem] items-center justify-center gap-2 rounded-sm border px-5 py-3 text-sm font-semibold transition",
        props.active
          ? "border-accent bg-accent text-accent-foreground hover:bg-accent-hover"
          : "border-border bg-bg-elevated text-txt hover:bg-bg-hover",
      ].join(" ")}
    >
      <Icon className="h-4 w-4" />
      <span>{props.label}</span>
      <span className="sr-only">{props.detail}</span>
    </button>
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
          : "border-border bg-bg-elevated text-txt hover:bg-bg-hover",
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

function promptForStep(step: FirstRunStep, agentNameValue: string): string {
  const agentName = normalizeFirstRunName(agentNameValue) || "Eliza";
  if (step === "remote") return "Where is the remote agent?";
  return `Where should ${agentName} run?`;
}

function useTypedPrompt(text: string): { rendered: string; complete: boolean } {
  const [rendered, setRendered] = React.useState(text);
  const [complete, setComplete] = React.useState(true);

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

function RuntimeDetail(props: {
  runtime: FirstRunRuntime;
  cloudConnected: boolean;
}) {
  const detail =
    props.runtime === "cloud"
      ? props.cloudConnected
        ? "Cloud account connected."
        : "Sign in before launch."
      : props.runtime === "remote"
        ? "Use an existing agent API."
        : "Start the bundled local agent.";
  return <p className="min-h-5 text-center text-sm text-muted">{detail}</p>;
}

function FirstRunStatus(props: {
  busyText: string | null;
  error: string | null;
  cloudError: string | null | undefined;
}) {
  if (props.busyText) {
    return (
      <p className="inline-flex min-h-[2.5rem] items-center justify-center gap-2 rounded-sm border border-border bg-bg-elevated px-4 py-2 text-sm text-muted">
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
}) {
  const buttonLabel = props.voice.speaking
    ? "Speaking"
    : props.voice.listening
      ? "Listening"
      : "Not listening";
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
          props.voice.listening ? "Stop voice input" : "Start voice input"
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
  elizaCloudConnected: boolean;
  submitting: boolean;
  primaryLabel: string;
  updateDraft: FirstRunDraftUpdate;
  setStep: (step: FirstRunStep) => void;
  finishRuntime: () => void;
}) {
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
          placeholder="Access token"
          type="password"
        />
        <div className="flex flex-wrap items-center justify-center gap-3">
          <GlassButton
            variant="secondary"
            disabled={props.submitting}
            onClick={() => props.setStep("runtime")}
          >
            Runtime
          </GlassButton>
          <GlassButton
            variant="primary"
            disabled={props.submitting}
            icon={props.submitting ? Loader2 : Check}
            onClick={props.finishRuntime}
          >
            {props.submitting ? "Working" : props.primaryLabel}
          </GlassButton>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <RuntimeButton
          active={props.draft.runtime === "local"}
          icon={HardDrive}
          label="Local"
          detail="Start the bundled local agent."
          onClick={() => props.updateDraft("runtime", "local")}
        />
        <RuntimeButton
          active={props.draft.runtime === "cloud"}
          icon={Cloud}
          label="Cloud"
          detail={
            props.elizaCloudConnected
              ? "Cloud account connected."
              : "Sign in before launch."
          }
          onClick={() => props.updateDraft("runtime", "cloud")}
        />
        <RuntimeButton
          active={props.draft.runtime === "remote"}
          icon={Network}
          label="Remote"
          detail="Use an agent API already running elsewhere."
          onClick={() => {
            props.updateDraft("runtime", "remote");
            props.setStep("remote");
          }}
        />
      </div>
      <RuntimeDetail
        runtime={props.draft.runtime}
        cloudConnected={props.elizaCloudConnected}
      />
      {props.draft.runtime === "cloud" ? (
        <div className="flex min-h-[2.5rem] items-center gap-2 rounded-sm border border-border bg-bg-elevated px-4 py-2 text-sm text-muted">
          <Checkbox
            aria-label="Keep embeddings local"
            checked={props.draft.useLocalEmbeddings}
            onCheckedChange={(checked) =>
              props.updateDraft("useLocalEmbeddings", checked === true)
            }
          />
          <span>Keep embeddings local</span>
        </div>
      ) : null}
      <GlassButton
        variant="primary"
        disabled={props.submitting}
        icon={props.submitting ? Loader2 : Check}
        onClick={props.finishRuntime}
      >
        {props.submitting ? "Working" : props.primaryLabel}
      </GlassButton>
    </div>
  );
}

export function FirstRunShell({
  step,
  draft,
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
  const promptText = React.useMemo(
    () => promptForStep(step, draft.agentName),
    [draft.agentName, step],
  );
  const { rendered: renderedPrompt, complete: promptComplete } =
    useTypedPrompt(promptText);

  React.useEffect(() => {
    if (promptComplete) onPromptReady(promptText);
  }, [onPromptReady, promptComplete, promptText]);

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
              className="inline-flex h-11 w-11 items-center justify-center rounded-sm border border-border bg-bg-elevated text-txt transition hover:bg-bg-hover"
              aria-label="Back"
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
                elizaCloudConnected={elizaCloudConnected}
                submitting={submitting}
                primaryLabel={primaryLabel}
                updateDraft={updateDraft}
                setStep={setStep}
                finishRuntime={finishRuntime}
              />
            ) : null}
            {promptComplete ? (
              <FirstRunVoiceControl voice={voice} toggleVoice={toggleVoice} />
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
