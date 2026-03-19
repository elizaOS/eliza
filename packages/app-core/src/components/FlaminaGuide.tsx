import { useApp } from "../state";
import type { AppState, FlaminaGuideTopic } from "../state/types";

type GuideContent = {
  title: string;
  description: string;
  whenToUse: string;
  skipEffect: string;
  characterImpact: string;
  recommended: string;
};

const GUIDE_CONTENT: Record<FlaminaGuideTopic, GuideContent> = {
  provider: {
    title: "Model and provider",
    description:
      "This picks the intelligence source behind your character.",
    whenToUse:
      "Choose it now if you care about reasoning style, latency, or subscription path.",
    skipEffect:
      "If you skip, Milady uses the recommended route so you can get into the app first.",
    characterImpact:
      "This affects how the character reasons, how fast it replies, and the overall output quality.",
    recommended:
      "Recommended default: use the detected or top recommended provider, then refine it later in settings.",
  },
  rpc: {
    title: "RPC and chain access",
    description:
      "RPC settings decide whether your character can reach chains, wallets, and external onchain actions.",
    whenToUse:
      "Configure this if the character needs to inspect balances, sign actions, or work with chains directly.",
    skipEffect:
      "If you skip, the character still works for chat and setup, but chain-connected actions stay limited.",
    characterImpact:
      "This affects the character’s access to wallets, chains, and external execution.",
    recommended:
      "Recommended default: skip for now unless onchain access is part of the first-run experience you need.",
  },
  permissions: {
    title: "Permissions and system access",
    description:
      "Permissions control what your character can see or do on this machine.",
    whenToUse:
      "Grant them now if you want the character to inspect the screen, use devices, or control local capabilities.",
    skipEffect:
      "If you skip, the character still starts, but system-aware actions stay unavailable until you enable them.",
    characterImpact:
      "This affects what the character can see, hear, and control locally.",
    recommended:
      "Recommended default: grant only the permissions you need today and defer the rest.",
  },
  voice: {
    title: "Voice and presentation",
    description:
      "Voice settings shape how the character sounds, not whether the character itself is saved.",
    whenToUse:
      "Configure this when spoken output matters for the experience or you want a specific presentation style.",
    skipEffect:
      "If you skip, the character identity still saves and works; only the voice layer stays deferred.",
    characterImpact:
      "This affects how the character sounds and feels in spoken interactions.",
    recommended:
      "Recommended default: save the character first, then tune voice once the core profile feels right.",
  },
};

const TASK_LABELS: Record<FlaminaGuideTopic, string> = {
  provider: "Provider setup",
  rpc: "RPC setup",
  permissions: "Permissions",
  voice: "Voice setup",
};

const TASK_DESCRIPTIONS: Record<FlaminaGuideTopic, string> = {
  provider: "Pick or refine the model/provider that powers the character.",
  rpc: "Add chain connectivity if the character needs wallet or onchain actions.",
  permissions: "Grant only the local access needed for system-aware behavior.",
  voice: "Tune how the character sounds without affecting its saved identity.",
};

export function FlaminaGuideCard({
  topic,
  className = "",
}: {
  topic: FlaminaGuideTopic;
  className?: string;
}) {
  const guide = GUIDE_CONTENT[topic];

  return (
    <section
      className={`rounded-2xl border border-accent/25 bg-card/70 px-4 py-4 text-left shadow-[0_10px_30px_rgba(var(--accent),0.08)] backdrop-blur-sm ${className}`.trim()}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-txt">
          Flamina
        </span>
        <h3 className="text-sm font-semibold text-txt-strong">{guide.title}</h3>
      </div>
      <p className="mb-3 text-sm text-muted">{guide.description}</p>
      <div className="space-y-2 text-xs leading-5 text-txt">
        <p>
          <span className="font-semibold text-txt-strong">When to use it:</span>{" "}
          {guide.whenToUse}
        </p>
        <p>
          <span className="font-semibold text-txt-strong">If you skip:</span>{" "}
          {guide.skipEffect}
        </p>
        <p>
          <span className="font-semibold text-txt-strong">
            How it affects the character:
          </span>{" "}
          {guide.characterImpact}
        </p>
        <p className="rounded-xl border border-accent/20 bg-accent/5 px-3 py-2 text-[11px] text-txt">
          {guide.recommended}
        </p>
      </div>
    </section>
  );
}

export function DeferredSetupChecklist({
  className = "",
  onOpenTask,
}: {
  className?: string;
  onOpenTask?: (task: FlaminaGuideTopic) => void;
}) {
  const {
    onboardingDeferredTasks,
    postOnboardingChecklistDismissed,
    setState,
  } = useApp();

  if (
    postOnboardingChecklistDismissed ||
    !Array.isArray(onboardingDeferredTasks) ||
    onboardingDeferredTasks.length === 0
  ) {
    return null;
  }

  const markDone = (task: FlaminaGuideTopic) => {
    setState(
      "onboardingDeferredTasks",
      onboardingDeferredTasks.filter(
        (current: AppState["onboardingDeferredTasks"][number]) =>
          current !== task,
      ),
    );
  };

  return (
    <section
      className={`rounded-2xl border border-border/60 bg-card/70 px-4 py-4 shadow-sm backdrop-blur-sm ${className}`.trim()}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-txt-strong">
            Finish setup later
          </h3>
          <p className="text-xs text-muted">
            Flamina kept the fast path open. These advanced items can be
            completed any time.
          </p>
        </div>
        <button
          type="button"
          className="rounded-full border border-border/60 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted transition-colors hover:text-txt"
          onClick={() => setState("postOnboardingChecklistDismissed", true)}
        >
          Dismiss
        </button>
      </div>

      <div className="space-y-2">
        {(onboardingDeferredTasks as FlaminaGuideTopic[]).map((task) => (
          <div
            key={task}
            className="flex flex-col gap-2 rounded-xl border border-border/50 bg-bg/50 px-3 py-3 md:flex-row md:items-center md:justify-between"
          >
            <div>
              <div className="text-sm font-medium text-txt-strong">
                {TASK_LABELS[task]}
              </div>
              <p className="text-xs text-muted">{TASK_DESCRIPTIONS[task]}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-txt"
                onClick={() => onOpenTask?.(task)}
              >
                Open
              </button>
              <button
                type="button"
                className="rounded-full border border-border/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted transition-colors hover:text-txt"
                onClick={() => markDone(task as FlaminaGuideTopic)}
              >
                Done
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
