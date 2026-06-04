import { useAgentElement } from "@elizaos/ui/agent-surface";
import { MessageSquareText, Mic2, Sparkles, Zap } from "lucide-react";
import {
  ASSISTANT_INTENTS,
  type AssistantIntent,
  LIFEOPS_ASSISTANT_INTENTS,
  LIFEOPS_VOICE_COMMAND_PROMPT,
} from "./LifeOpsAssistantSection.helpers.js";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.helpers.js";

function AssistantIntentGridButton({
  intent,
  onLaunch,
}: {
  intent: AssistantIntent;
  onLaunch: (intent: AssistantIntent) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `assistant-intent-${intent.id}`,
    role: "button",
    label: intent.label,
    group: "lifeops-assistant",
    description: `Run the ${intent.label} assistant command`,
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-label={intent.label}
      title={intent.label}
      data-testid="lifeops-assistant-intent"
      data-intent-id={intent.id}
      className="group flex h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-border/35 bg-bg/70 px-1.5 text-center transition-colors hover:bg-bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      onClick={() => onLaunch(intent)}
      {...agentProps}
    >
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bg-muted/60 text-txt">
        <span
          aria-hidden
          className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${intent.tone}`}
        />
        {intent.icon}
      </span>
      <span className="max-w-full truncate text-[0.6875rem] font-semibold leading-none text-txt">
        {intent.shortLabel}
      </span>
    </button>
  );
}

function AssistantQuickIntentButton({
  intent,
  onLaunch,
}: {
  intent: AssistantIntent;
  onLaunch: (intent: AssistantIntent) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `assistant-quick-${intent.id}`,
    role: "button",
    label: `Quick ${intent.label}`,
    group: "lifeops-assistant",
    description: `Quick-run the ${intent.label} assistant command`,
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Quick ${intent.label}`}
      className="flex h-10 items-center justify-center rounded-lg bg-bg-muted/35 text-txt transition-colors hover:bg-bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      onClick={() => onLaunch(intent)}
      {...agentProps}
    >
      {intent.icon}
    </button>
  );
}

export function LifeOpsAssistantIntentGrid({
  intents = LIFEOPS_ASSISTANT_INTENTS,
  onLaunch,
}: {
  intents?: AssistantIntent[];
  onLaunch: (intent: AssistantIntent) => void;
}) {
  return (
    <div
      className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10"
      data-testid="lifeops-assistant-intents"
    >
      {intents.map((intent) => (
        <AssistantIntentGridButton
          key={intent.id}
          intent={intent}
          onLaunch={onLaunch}
        />
      ))}
    </div>
  );
}

export function LifeOpsAssistantSection() {
  const { openLifeOpsChat } = useLifeOpsChatLauncher();
  const commandBriefPrompt =
    ASSISTANT_INTENTS[0]?.prompt ?? "Give me a LifeOps command brief.";
  const commandBrief = useAgentElement<HTMLButtonElement>({
    id: "assistant-command-brief",
    role: "button",
    label: "Ask LifeOps command brief",
    group: "lifeops-assistant",
    description: "Open the LifeOps command brief in chat",
  });
  const voiceCommand = useAgentElement<HTMLButtonElement>({
    id: "assistant-voice-command",
    role: "button",
    label: "Voice command",
    group: "lifeops-assistant",
    description: "Start a LifeOps voice command",
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex min-h-[11rem] flex-col justify-end rounded-lg border border-border/30 bg-bg/70 p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3 text-muted">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-wide">
              Assistant
            </span>
          </div>
          <div className="flex items-center gap-1.5" aria-hidden>
            <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <button
            ref={commandBrief.ref}
            type="button"
            aria-label="Open LifeOps command brief"
            data-testid="lifeops-assistant-command-brief"
            className="group grid min-h-[5rem] w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border border-border/35 bg-bg-muted/35 p-3 text-left transition-colors hover:bg-bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            onClick={() =>
              openLifeOpsChat(commandBriefPrompt, {}, { select: true })
            }
            {...commandBrief.agentProps}
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-accent/18 text-txt">
              <MessageSquareText className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold text-txt">
                Ask LifeOps
              </span>
              <span className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                <Zap className="h-3.5 w-3.5" aria-hidden />
                <span>Command brief</span>
              </span>
            </span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/25 bg-bg/70 text-muted transition-colors group-hover:text-txt">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
          </button>
          <button
            ref={voiceCommand.ref}
            type="button"
            aria-label="Open LifeOps voice command"
            data-testid="lifeops-assistant-voice-command"
            className="group flex min-h-[5rem] items-center justify-center gap-2 rounded-lg border border-border/35 bg-bg-muted/35 px-4 text-txt transition-colors hover:bg-bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 sm:w-24 sm:flex-col"
            onClick={() =>
              openLifeOpsChat(
                LIFEOPS_VOICE_COMMAND_PROMPT,
                {},
                { select: false },
              )
            }
            {...voiceCommand.agentProps}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg/70 text-txt">
              <Mic2 className="h-5 w-5" aria-hidden />
            </span>
            <span className="text-xs-tight font-semibold text-muted group-hover:text-txt">
              Voice
            </span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2 rounded-lg border border-border/25 bg-bg/55 p-2">
        {ASSISTANT_INTENTS.slice(0, 5).map((intent) => (
          <AssistantQuickIntentButton
            key={`quick-${intent.id}`}
            intent={intent}
            onLaunch={(launched) =>
              openLifeOpsChat(launched.prompt, {}, { select: true })
            }
          />
        ))}
      </div>

      <LifeOpsAssistantIntentGrid
        onLaunch={(intent) => {
          openLifeOpsChat(intent.prompt, {}, { select: true });
        }}
      />
    </div>
  );
}
