import { ChevronDown, Cloud, Cpu, KeyRound, Loader2 } from "lucide-react";
import * as React from "react";
import type { ConversationMessage } from "../api";
import { ElizaMark } from "../components/brand/eliza-mark";
import { getBootConfig } from "../config/boot-config-store";
import { Z_FIRST_RUN_CHOOSER } from "../lib/floating-layers";
import { useAppSelectorShallow } from "../state";
import { useConversationMessages } from "../state/ConversationMessagesContext.hooks";
import { preOpenWindow } from "../utils";
import {
  FIRST_RUN_ACTION_PREFIX,
  tryHandleFirstRunAction,
} from "./first-run-action-channel";

type RuntimeChoice = "cloud" | "local" | "other";
type ProviderChoice = "on-device" | "elizacloud" | "other";
type ChooserStep = "runtime" | "provider";

const FIRST_RUN_RUNTIME_PROVIDER_CHOICE_PATTERN =
  /\[CHOICE:first-run id=(?:runtime|provider)\]/;
const FIRST_RUN_BACKUP_RESTORE_CHOICE_PATTERN =
  /\[CHOICE:first-run id=backup-restore\]/;

type FirstRunChoiceCandidate = Pick<ConversationMessage, "id"> &
  Partial<Pick<ConversationMessage, "text">> & { content?: string };

function firstRunChoiceBody(message: FirstRunChoiceCandidate): string {
  if (typeof message.content === "string") return message.content;
  if (typeof message.text === "string") return message.text;
  return "";
}

export function isSyntheticFirstRunChoiceTurn(
  message: FirstRunChoiceCandidate,
): boolean {
  return (
    message.id.startsWith("first-run:") &&
    FIRST_RUN_RUNTIME_PROVIDER_CHOICE_PATTERN.test(firstRunChoiceBody(message))
  );
}

export function hasPendingFirstRunBackupRestoreChoice(
  messages: FirstRunChoiceCandidate[],
): boolean {
  const hasBackupRestoreChoice = messages.some(
    (message) =>
      message.id.startsWith("first-run:backup-restore") &&
      FIRST_RUN_BACKUP_RESTORE_CHOICE_PATTERN.test(firstRunChoiceBody(message)),
  );
  if (!hasBackupRestoreChoice) return false;
  return !messages.some((message) => message.id === "first-run:greeting");
}

type ChoiceDefinition = {
  id: RuntimeChoice;
  title: string;
  description: string;
  Icon: typeof Cloud;
  testId: string;
};

const PRIMARY_CHOICES: ChoiceDefinition[] = [
  {
    id: "cloud",
    title: "Sign in with Eliza Cloud",
    description:
      "Use the managed runtime, sync, and hosted agent from your account.",
    Icon: Cloud,
    testId: "first-run-chooser-cloud",
  },
  {
    id: "local",
    title: "Run on this device",
    description:
      "Start a local agent and choose on-device or cloud inference next.",
    Icon: Cpu,
    testId: "first-run-chooser-local",
  },
];

const ADVANCED_CHOICE: ChoiceDefinition = {
  id: "other",
  title: "Bring your own keys",
  description:
    "Run locally and configure your preferred model provider in Settings.",
  Icon: KeyRound,
  testId: "first-run-chooser-other",
};

export type FirstRunRuntimeChooserSurfaceProps = {
  appName: string;
  step: ChooserStep;
  busyChoice: RuntimeChoice | ProviderChoice | null;
  error: string | null;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  onSelect: (choice: RuntimeChoice) => void;
  onProviderSelect: (choice: ProviderChoice) => void;
  onBack: () => void;
};

export function FirstRunRuntimeChooserSurface({
  appName,
  step,
  busyChoice,
  error,
  advancedOpen,
  onToggleAdvanced,
  onSelect,
  onProviderSelect,
  onBack,
}: FirstRunRuntimeChooserSurfaceProps): React.ReactElement {
  const onProviderStep = step === "provider";
  return (
    <div
      className="fixed inset-0 flex items-start justify-center overflow-y-auto bg-black/60 px-5 py-[calc(var(--safe-area-top,0px)+3rem)] text-white backdrop-blur-xl sm:items-center sm:py-8"
      data-testid="first-run-runtime-chooser"
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-runtime-chooser-title"
      style={{ zIndex: Z_FIRST_RUN_CHOOSER }}
    >
      <div className="flex w-full max-w-[27rem] flex-col gap-7">
        <div className="flex items-center justify-center gap-3">
          <ElizaMark className="h-11 w-11" />
          <span className="text-3xl font-medium leading-none tracking-normal">
            {appName}
          </span>
        </div>

        <div className="flex flex-col gap-3 text-center">
          <h1
            id="first-run-runtime-chooser-title"
            className="text-[22px] font-semibold tracking-normal"
          >
            {onProviderStep
              ? "Choose how Eliza should think"
              : "Choose how Eliza should run"}
          </h1>
          <p className="text-sm leading-6 text-white/70">
            {onProviderStep
              ? "Use the on-device default, Eliza Cloud inference, or configure your own provider."
              : "Pick the clean default now. Advanced provider setup stays one tap away."}
          </p>
        </div>

        {onProviderStep ? (
          <div className="flex flex-col gap-3">
            <ProviderChoiceButton
              id="on-device"
              title="On this device"
              description="Download and run the recommended local model."
              Icon={Cpu}
              busy={busyChoice === "on-device"}
              disabled={busyChoice !== null}
              onSelect={onProviderSelect}
            />
            <ProviderChoiceButton
              id="elizacloud"
              title="Eliza Cloud inference"
              description="Keep the agent local, but use cloud-hosted model inference."
              Icon={Cloud}
              busy={busyChoice === "elizacloud"}
              disabled={busyChoice !== null}
              onSelect={onProviderSelect}
            />
            <ProviderChoiceButton
              id="other"
              title="Other provider"
              description="Continue locally and configure keys in Settings."
              Icon={KeyRound}
              busy={busyChoice === "other"}
              disabled={busyChoice !== null}
              onSelect={onProviderSelect}
            />
            <button
              type="button"
              className="min-h-11 rounded-md px-3 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-60"
              disabled={busyChoice !== null}
              onClick={onBack}
            >
              Back
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {PRIMARY_CHOICES.map((choice) => (
              <RuntimeChoiceButton
                key={choice.id}
                choice={choice}
                busy={busyChoice === choice.id}
                disabled={busyChoice !== null}
                onSelect={onSelect}
              />
            ))}

            <div className="rounded-lg border border-white/12 bg-white/[0.06]">
              <button
                type="button"
                className="flex min-h-12 w-full items-center justify-between gap-3 px-4 text-left text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.06] disabled:opacity-60"
                aria-expanded={advancedOpen}
                onClick={onToggleAdvanced}
                disabled={busyChoice !== null}
              >
                <span>Advanced setup</span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                  aria-hidden
                />
              </button>
              {advancedOpen ? (
                <div className="border-t border-white/10 p-3">
                  <RuntimeChoiceButton
                    choice={ADVANCED_CHOICE}
                    busy={busyChoice === ADVANCED_CHOICE.id}
                    disabled={busyChoice !== null}
                    onSelect={onSelect}
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}

        {error ? (
          <div
            className="rounded-md border border-red-300/30 bg-red-950/35 px-3 py-2 text-sm leading-5 text-red-100"
            role="status"
          >
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProviderChoiceButton({
  id,
  title,
  description,
  Icon,
  busy,
  disabled,
  onSelect,
}: {
  id: ProviderChoice;
  title: string;
  description: string;
  Icon: typeof Cloud;
  busy: boolean;
  disabled: boolean;
  onSelect: (choice: ProviderChoice) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={`first-run-provider-${id}`}
      disabled={disabled}
      onClick={() => onSelect(id)}
      className="group flex min-h-[5.75rem] w-full items-center gap-4 rounded-lg border border-white/14 bg-white/[0.08] px-4 py-3 text-left transition-[border-color,background-color,transform] hover:border-white/32 hover:bg-white/[0.12] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-70"
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-white/12 bg-black/25 text-white/90">
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        ) : (
          <Icon className="h-5 w-5" aria-hidden />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold leading-5 tracking-normal text-white">
          {title}
        </span>
        <span className="mt-1 block text-sm leading-5 text-white/62">
          {description}
        </span>
      </span>
    </button>
  );
}

function RuntimeChoiceButton({
  choice,
  busy,
  disabled,
  onSelect,
}: {
  choice: ChoiceDefinition;
  busy: boolean;
  disabled: boolean;
  onSelect: (choice: RuntimeChoice) => void;
}): React.ReactElement {
  const { Icon } = choice;
  return (
    <button
      type="button"
      data-testid={choice.testId}
      disabled={disabled}
      onClick={() => onSelect(choice.id)}
      className="group flex min-h-[5.75rem] w-full items-center gap-4 rounded-lg border border-white/14 bg-white/[0.08] px-4 py-3 text-left transition-[border-color,background-color,transform] hover:border-white/32 hover:bg-white/[0.12] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-70"
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-white/12 bg-black/25 text-white/90">
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        ) : (
          <Icon className="h-5 w-5" aria-hidden />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold leading-5 tracking-normal text-white">
          {choice.title}
        </span>
        <span className="mt-1 block text-sm leading-5 text-white/62">
          {choice.description}
        </span>
      </span>
    </button>
  );
}

export function FirstRunRuntimeChooser(): React.ReactElement | null {
  const { firstRunComplete, handleCloudLogin, startupPhase } =
    useAppSelectorShallow((state) => ({
      firstRunComplete: state.firstRunComplete,
      handleCloudLogin: state.handleCloudLogin,
      startupPhase: state.startupCoordinator.phase,
    }));
  const [dismissed, setDismissed] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [step, setStep] = React.useState<ChooserStep>("runtime");
  const [busyChoice, setBusyChoice] = React.useState<
    RuntimeChoice | ProviderChoice | null
  >(null);
  const [error, setError] = React.useState<string | null>(null);
  const { conversationMessages, setConversationMessages } =
    useConversationMessages();
  const active =
    firstRunComplete === false && startupPhase === "first-run-required";
  const backupRestorePending =
    hasPendingFirstRunBackupRestoreChoice(conversationMessages);

  const removeSyntheticChoiceTurns = React.useCallback(() => {
    setConversationMessages((previous) => {
      let changed = false;
      const next = previous.filter((message) => {
        const remove = isSyntheticFirstRunChoiceTurn(message);
        changed ||= remove;
        return !remove;
      });
      return changed ? next : previous;
    });
  }, [setConversationMessages]);

  React.useEffect(() => {
    if (!active || dismissed) return;
    const hasSyntheticChoiceTurns = conversationMessages.some(
      isSyntheticFirstRunChoiceTurn,
    );
    if (!hasSyntheticChoiceTurns) return;
    removeSyntheticChoiceTurns();
  }, [active, conversationMessages, dismissed, removeSyntheticChoiceTurns]);

  React.useEffect(() => {
    if (active) return;
    setDismissed(false);
    setAdvancedOpen(false);
    setStep("runtime");
    setBusyChoice(null);
    setError(null);
  }, [active]);

  if (!active || dismissed || backupRestorePending) return null;

  const appName = getBootConfig().branding?.appName ?? "elizaOS";

  return (
    <FirstRunRuntimeChooserSurface
      appName={appName}
      step={step}
      advancedOpen={advancedOpen}
      busyChoice={busyChoice}
      error={error}
      onToggleAdvanced={() => {
        setAdvancedOpen((value) => !value);
        setError(null);
      }}
      onSelect={(choice) => {
        setBusyChoice(choice);
        setError(null);
        const cloudAuthWindow = choice === "cloud" ? preOpenWindow() : null;
        const handled = tryHandleFirstRunAction(
          `${FIRST_RUN_ACTION_PREFIX}runtime:${choice}`,
        );
        if (!handled) {
          cloudAuthWindow?.close();
          setBusyChoice(null);
          setError("Setup is still initializing. Try again in a moment.");
          return;
        }
        removeSyntheticChoiceTurns();
        if (choice === "cloud") {
          void handleCloudLogin(cloudAuthWindow).catch(() => {
            // The cloud state hook owns the user-facing login error; the
            // conductor also reports provisioning failures in the transcript.
          });
          setDismissed(true);
          return;
        }
        setBusyChoice(null);
        setStep("provider");
      }}
      onProviderSelect={(choice) => {
        setBusyChoice(choice);
        setError(null);
        const handled = tryHandleFirstRunAction(
          `${FIRST_RUN_ACTION_PREFIX}provider:${choice}`,
        );
        if (!handled) {
          setBusyChoice(null);
          setError("Setup is still initializing. Try again in a moment.");
          return;
        }
        removeSyntheticChoiceTurns();
        setDismissed(true);
      }}
      onBack={() => {
        setStep("runtime");
        setBusyChoice(null);
        setError(null);
      }}
    />
  );
}
