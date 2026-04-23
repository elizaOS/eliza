import { useApp } from "@elizaos/app-core/state";
import { useBranding } from "../../config/branding";
import { getOnboardingNavMetas } from "../../onboarding/flow";
import type {
  AppContextValue,
  OnboardingStep,
  OnboardingStepMeta,
} from "../../state/types";

function PureOnboardingStepNav(props: {
  currentStep: OnboardingStep;
  onboardingNavMetas: OnboardingStepMeta[];
  handleOnboardingJumpToStep: (step: OnboardingStep) => void;
  t: AppContextValue["t"];
}) {
  const { currentStep, onboardingNavMetas, handleOnboardingJumpToStep, t } =
    props;

  const currentIndex = onboardingNavMetas.findIndex(
    (step) => step.id === currentStep,
  );

  return (
    <nav className="w-full" aria-label={t("onboarding.stepNavigation")}>
      <ol className="mx-auto flex w-full max-w-[46rem] flex-col gap-2 sm:flex-row">
        {onboardingNavMetas.map((step, index) => {
          const isDone = index < currentIndex;
          const isActive = index === currentIndex;
          const isClickable = isDone;
          const stepNumber = String(index + 1).padStart(2, "0");
          const shellClass = `group flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-[border-color,background-color,box-shadow,color] duration-200 ${
            isActive
              ? "border-[rgba(240,185,11,0.42)] bg-[rgba(240,185,11,0.12)] shadow-[0_14px_32px_rgba(0,0,0,0.18)]"
              : isDone
                ? "border-[rgba(240,185,11,0.22)] bg-[rgba(255,255,255,0.04)] hover:border-[rgba(240,185,11,0.34)] hover:bg-[rgba(240,185,11,0.08)]"
                : "border-[rgba(255,255,255,0.09)] bg-[rgba(255,255,255,0.02)]"
          } ${
            isClickable
              ? "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(242,210,122,0.78)] focus-visible:ring-offset-2 focus-visible:ring-offset-[rgba(8,10,14,0.92)]"
              : "pointer-events-none"
          }`;

          const content = (
            <>
              <div
                aria-hidden="true"
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tracking-[0.18em] transition-colors duration-200 ${
                  isActive
                    ? "border-accent/80 bg-accent/20 text-accent font-bold"
                    : isDone
                      ? "border-accent/40 bg-accent/10 text-accent/70"
                      : "border-white/12 bg-white/4 text-white/30"
                }`}
              >
                {stepNumber}
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={`text-sm font-medium tracking-[0.08em] transition-colors duration-200 ${
                    isActive
                      ? "text-white"
                      : isDone
                        ? "text-accent/80"
                        : "text-white/40"
                  }`}
                >
                  {t(step.name)}
                </div>
                <div
                  className={`mt-1 text-xs leading-relaxed transition-colors duration-200 ${
                    isActive
                      ? "text-white/60"
                      : isDone
                        ? "text-white/40"
                        : "text-white/20"
                  }`}
                >
                  {t(step.subtitle)}
                </div>
              </div>
            </>
          );

          if (isClickable) {
            return (
              <li key={step.id} className="flex-1 list-none">
                <button
                  type="button"
                  className={shellClass}
                  title={t(step.name)}
                  aria-label={`${t(step.name)} — ${t("onboarding.stepLabel", { current: index + 1, total: onboardingNavMetas.length })} (${t("onboarding.completed")})`}
                  onClick={() => handleOnboardingJumpToStep(step.id)}
                >
                  {content}
                </button>
              </li>
            );
          }

          return (
            <li key={step.id} className="flex-1 list-none">
              <div
                className={shellClass}
                title={t(step.name)}
                {...(isActive ? { "aria-current": "step" as const } : {})}
              >
                {content}
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function OnboardingStepNav() {
  const { onboardingStep, handleOnboardingJumpToStep, t } = useApp();
  const branding = useBranding();

  const isCloudOnly = Boolean(branding.cloudOnly);
  const onboardingNavMetas = getOnboardingNavMetas(onboardingStep, isCloudOnly);

  return (
    <PureOnboardingStepNav
      currentStep={onboardingStep}
      onboardingNavMetas={onboardingNavMetas}
      handleOnboardingJumpToStep={handleOnboardingJumpToStep}
      t={t}
    />
  );
}
