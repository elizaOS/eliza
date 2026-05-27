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
  goNext: () => void;
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
        "inline-flex min-h-[3.25rem] items-center justify-center gap-2 rounded-lg border px-5 py-3 text-sm font-semibold shadow-[0_16px_32px_rgba(11,53,241,0.12)] transition",
        props.active
          ? "border-[#0B35F1] bg-[#0B35F1] text-white"
          : "border-[#0B35F1]/20 bg-white text-[#0B35F1] hover:border-[#0B35F1]/40 hover:bg-[#F7F9FF]",
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
        "inline-flex min-h-[3rem] min-w-[7rem] items-center justify-center gap-2 rounded-lg border px-5 py-3 text-sm font-semibold shadow-[0_16px_32px_rgba(11,53,241,0.12)] transition disabled:pointer-events-none disabled:opacity-45",
        props.variant === "primary"
          ? "border-[#0B35F1] bg-[#0B35F1] text-white hover:bg-[#082ed6]"
          : "border-[#0B35F1]/20 bg-white text-[#0B35F1] hover:border-[#0B35F1]/40 hover:bg-[#F7F9FF]",
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
        "w-full border-0 border-b-2 border-[#0B35F1]/35 bg-transparent px-2 pb-3 text-center font-medium text-[#0B35F1] outline-none placeholder:text-[#0B35F1]/40 focus:border-[#0B35F1]",
        props.compact ? "text-2xl" : "text-4xl",
      ].join(" ")}
    />
  );
}

function promptForStep(step: FirstRunStep, agentNameValue: string): string {
  const agentName = normalizeFirstRunName(agentNameValue) || "Milady";
  if (step === "owner") return "What should Milady call you?";
  if (step === "agent") return "What should this agent be called?";
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
  return (
    <p className="min-h-5 text-center text-sm text-[#0B35F1]/70">{detail}</p>
  );
}

function FirstRunStatus(props: {
  busyText: string | null;
  error: string | null;
  cloudError: string | null | undefined;
}) {
  if (props.busyText) {
    return (
      <p className="inline-flex min-h-[2.5rem] items-center justify-center gap-2 rounded-lg border border-[#0B35F1]/15 bg-white px-4 py-2 text-sm text-[#0B35F1]/80 shadow-[0_14px_28px_rgba(11,53,241,0.1)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {props.busyText}
      </p>
    );
  }
  const message = props.error ?? props.cloudError;
  if (!message) return <div className="min-h-[2.5rem]" />;
  return (
    <p className="max-w-[40rem] rounded-lg border border-red-200 bg-white px-4 py-2 text-center text-sm text-red-700 shadow-[0_14px_28px_rgba(11,53,241,0.1)]">
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
    <div className="flex min-h-[2.75rem] flex-wrap items-center justify-center gap-3 text-[#0B35F1]/72">
      <button
        type="button"
        onClick={() => {
          void props.toggleVoice();
        }}
        aria-pressed={props.voice.listening}
        aria-label={
          props.voice.listening ? "Stop voice input" : "Start voice input"
        }
        className="inline-flex min-h-11 min-w-[8.5rem] items-center justify-center bg-transparent px-2 py-2 text-sm font-semibold text-[#0B35F1] transition hover:text-[#082ed6] focus-visible:outline-none focus-visible:underline"
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
  goNext: () => void;
  finishRuntime: () => void;
}) {
  if (props.step === "owner") {
    return (
      <div className="grid w-full justify-items-center gap-5">
        <BareInput
          autoFocus
          value={props.draft.ownerName}
          onChange={(value) => props.updateDraft("ownerName", value)}
          onEnter={props.goNext}
          placeholder="Your name"
        />
        <GlassButton
          variant="primary"
          disabled={props.submitting}
          onClick={props.goNext}
        >
          {props.primaryLabel}
        </GlassButton>
      </div>
    );
  }

  if (props.step === "agent") {
    return (
      <div className="grid w-full justify-items-center gap-5">
        <BareInput
          autoFocus
          value={props.draft.agentName}
          onChange={(value) => props.updateDraft("agentName", value)}
          onEnter={props.goNext}
          placeholder="Agent name"
        />
        <GlassButton
          variant="primary"
          disabled={props.submitting}
          onClick={props.goNext}
        >
          {props.primaryLabel}
        </GlassButton>
      </div>
    );
  }

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
        <div className="flex min-h-[2.5rem] items-center gap-2 rounded-lg border border-[#0B35F1]/15 bg-white px-4 py-2 text-sm text-[#0B35F1]/80 shadow-[0_14px_28px_rgba(11,53,241,0.1)]">
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
  goNext,
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
      className="first-run-screen relative flex min-h-[100dvh] w-full overflow-hidden bg-[#F7F9FF] text-[#0B35F1]"
    >
      <div className="relative z-10 flex min-h-[100dvh] w-full flex-col px-4 py-4 sm:px-6 sm:py-6">
        <div className="flex h-12 items-center">
          {canBack ? (
            <button
              type="button"
              onClick={goBack}
              className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-[#0B35F1]/20 bg-white text-[#0B35F1] shadow-[0_16px_32px_rgba(11,53,241,0.12)] transition hover:border-[#0B35F1]/40 hover:bg-[#F7F9FF]"
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : null}
        </div>

        <div className="mx-auto flex w-full max-w-[70rem] flex-1 flex-col items-center justify-center gap-10 pb-[8vh] pt-6">
          <h1 className="min-h-[8.5rem] max-w-[64rem] text-center text-4xl font-semibold leading-tight text-[#0B35F1] sm:min-h-[10rem] sm:text-6xl">
            {renderedPrompt}
            {!promptComplete ? <span aria-hidden="true">|</span> : null}
          </h1>

          <div
            className={[
              "flex min-h-[14rem] w-full max-w-[44rem] flex-col items-center justify-center gap-6 transition duration-300",
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
                goNext={goNext}
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
