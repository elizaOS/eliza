import { Button } from "@elizaos/ui";
import { useApp } from "../../state";
import type { AppState, FlaminaGuideTopic } from "../../state/types";

type GuideContent = {
  titleKey: string;
  descriptionKey: string;
  whenToUseKey: string;
  skipEffectKey: string;
  characterImpactKey: string;
  recommendedKey: string;
  titleDefault?: string;
  descriptionDefault?: string;
  whenToUseDefault?: string;
  skipEffectDefault?: string;
  characterImpactDefault?: string;
  recommendedDefault?: string;
};

const GUIDE_CONTENT: Record<FlaminaGuideTopic, GuideContent> = {
  provider: {
    titleKey: "flaminaguide.provider.title",
    descriptionKey: "flaminaguide.provider.description",
    whenToUseKey: "flaminaguide.provider.whenToUse",
    skipEffectKey: "flaminaguide.provider.skipEffect",
    characterImpactKey: "flaminaguide.provider.characterImpact",
    recommendedKey: "flaminaguide.provider.recommended",
  },
  rpc: {
    titleKey: "flaminaguide.rpc.title",
    descriptionKey: "flaminaguide.rpc.description",
    whenToUseKey: "flaminaguide.rpc.whenToUse",
    skipEffectKey: "flaminaguide.rpc.skipEffect",
    characterImpactKey: "flaminaguide.rpc.characterImpact",
    recommendedKey: "flaminaguide.rpc.recommended",
  },
  permissions: {
    titleKey: "flaminaguide.permissions.title",
    descriptionKey: "flaminaguide.permissions.description",
    whenToUseKey: "flaminaguide.permissions.whenToUse",
    skipEffectKey: "flaminaguide.permissions.skipEffect",
    characterImpactKey: "flaminaguide.permissions.characterImpact",
    recommendedKey: "flaminaguide.permissions.recommended",
  },
  voice: {
    titleKey: "flaminaguide.voice.title",
    descriptionKey: "flaminaguide.voice.description",
    whenToUseKey: "flaminaguide.voice.whenToUse",
    skipEffectKey: "flaminaguide.voice.skipEffect",
    characterImpactKey: "flaminaguide.voice.characterImpact",
    recommendedKey: "flaminaguide.voice.recommended",
  },
  features: {
    titleKey: "flaminaguide.features.title",
    descriptionKey: "flaminaguide.features.description",
    whenToUseKey: "flaminaguide.features.whenToUse",
    skipEffectKey: "flaminaguide.features.skipEffect",
    characterImpactKey: "flaminaguide.features.characterImpact",
    recommendedKey: "flaminaguide.features.recommended",
  },
};

type GuideLabel = {
  key: string;
  defaultValue?: string;
};

const TASK_LABELS: Record<FlaminaGuideTopic, GuideLabel> = {
  provider: { key: "flaminaguide.tasks.provider.label" },
  rpc: { key: "flaminaguide.tasks.rpc.label" },
  permissions: { key: "flaminaguide.tasks.permissions.label" },
  voice: { key: "flaminaguide.tasks.voice.label" },
  features: { key: "flaminaguide.tasks.features.label" },
};

const TASK_DESCRIPTIONS: Record<FlaminaGuideTopic, GuideLabel> = {
  provider: { key: "flaminaguide.tasks.provider.description" },
  rpc: { key: "flaminaguide.tasks.rpc.description" },
  permissions: { key: "flaminaguide.tasks.permissions.description" },
  voice: { key: "flaminaguide.tasks.voice.description" },
  features: { key: "flaminaguide.tasks.features.description" },
};

export function FlaminaGuideCard({
  topic,
  className = "",
}: {
  topic: FlaminaGuideTopic;
  className?: string;
}) {
  const { t } = useApp();
  const guide = GUIDE_CONTENT[topic];

  return (
    <section
      className={`rounded-2xl border border-accent/25 bg-card/70 px-4 py-4 text-left shadow-[0_10px_30px_rgba(var(--accent-rgb),0.08)] backdrop-blur-sm ${className}`.trim()}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-1 text-2xs font-semibold uppercase tracking-[0.16em] text-txt">
          Flamina
        </span>
        <h3 className="text-sm font-semibold text-txt-strong">
          {t(guide.titleKey, { defaultValue: guide.titleDefault })}
        </h3>
      </div>
      <p className="mb-3 text-sm text-muted">
        {t(guide.descriptionKey, { defaultValue: guide.descriptionDefault })}
      </p>
      <div className="space-y-2 text-xs leading-5 text-txt">
        <p>
          <span className="font-semibold text-txt-strong">
            {t("flaminaguide.WhenToUseLabel")}
          </span>{" "}
          {t(guide.whenToUseKey, { defaultValue: guide.whenToUseDefault })}
        </p>
        <p>
          <span className="font-semibold text-txt-strong">
            {t("flaminaguide.IfYouSkipLabel")}
          </span>{" "}
          {t(guide.skipEffectKey, { defaultValue: guide.skipEffectDefault })}
        </p>
        <p>
          <span className="font-semibold text-txt-strong">
            {t("flaminaguide.CharacterImpactLabel")}
          </span>{" "}
          {t(guide.characterImpactKey, {
            defaultValue: guide.characterImpactDefault,
          })}
        </p>
        <p className="rounded-xl border border-accent/20 bg-accent/5 px-3 py-2 text-xs-tight text-txt">
          {t(guide.recommendedKey, { defaultValue: guide.recommendedDefault })}
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
    t,
  } = useApp();

  if (
    postOnboardingChecklistDismissed ||
    !Array.isArray(onboardingDeferredTasks) ||
    onboardingDeferredTasks.length === 0
  ) {
    return null;
  }

  const tasks = onboardingDeferredTasks.filter(
    (task): task is FlaminaGuideTopic =>
      typeof task === "string" && task in TASK_LABELS,
  );
  if (tasks.length === 0) {
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
            {t("flaminaguide.FinishSetupLater")}
          </h3>
          <p className="text-xs text-muted">
            {t("flaminaguide.FinishSetupLaterDescription")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full text-xs-tight font-semibold uppercase tracking-[0.12em] text-muted"
          onClick={() => setState("postOnboardingChecklistDismissed", true)}
        >
          {t("common.dismiss")}
        </Button>
      </div>

      <div className="space-y-2">
        {tasks.map((task) => (
          <div
            key={task}
            className="flex flex-col gap-2 rounded-xl border border-border/50 bg-bg/50 px-3 py-3 md:flex-row md:items-center md:justify-between"
          >
            <div>
              <div className="text-sm font-medium text-txt-strong">
                {t(TASK_LABELS[task].key, {
                  defaultValue: TASK_LABELS[task].defaultValue,
                })}
              </div>
              <p className="text-xs text-muted">
                {t(TASK_DESCRIPTIONS[task].key, {
                  defaultValue: TASK_DESCRIPTIONS[task].defaultValue,
                })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="rounded-full border-accent/30 bg-accent/10 text-xs-tight font-semibold uppercase tracking-[0.12em]"
                onClick={() => onOpenTask?.(task)}
              >
                {t("common.open")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full text-xs-tight font-semibold uppercase tracking-[0.12em] text-muted"
                onClick={() => markDone(task)}
              >
                {t("common.done")}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
