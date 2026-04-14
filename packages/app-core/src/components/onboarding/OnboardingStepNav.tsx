import { useApp } from "../../state/useApp";
import { Button } from "@elizaos/ui/components/ui/button";
import { useBranding } from "../../config/branding";
import { getOnboardingNavMetas } from "../../onboarding/flow";

export function OnboardingStepNav() {
  const { onboardingStep, handleOnboardingJumpToStep, t } = useApp();
  const branding = useBranding();

  const isCloudOnly = Boolean(branding.cloudOnly);
  const activeSteps = getOnboardingNavMetas(onboardingStep, isCloudOnly);
  const currentIndex = activeSteps.findIndex(
    (step) => step.id === onboardingStep,
  );

  return (
    <nav className="w-full" aria-label={t("onboarding.stepNavigation")}>
      <ol className="mx-auto flex w-full max-w-[46rem] flex-col gap-2 sm:flex-row">
        {activeSteps.map((step, index) => {
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
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tracking-[0.18em] ${
                  isActive
                    ? "border-[rgba(255,248,220,0.92)] bg-[rgba(240,185,11,0.2)] text-[var(--onboarding-text-strong)]"
                    : isDone
                      ? "border-[rgba(240,185,11,0.34)] bg-[rgba(240,185,11,0.12)] text-[var(--onboarding-link)]"
                      : "border-[rgba(255,255,255,0.12)] bg-[rgba(255,255,255,0.04)] text-[var(--onboarding-text-faint)]"
                }`}
              >
                {stepNumber}
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={`text-sm font-medium tracking-[0.08em] ${
                    isActive
                      ? "text-[var(--onboarding-text-strong)]"
                      : isDone
                        ? "text-[var(--onboarding-link)]"
                        : "text-[var(--onboarding-text-subtle)]"
                  }`}
                >
                  {t(step.name)}
                </div>
                <div
                  className={`mt-1 text-xs leading-relaxed ${
                    isActive
                      ? "text-[var(--onboarding-text-muted)]"
                      : isDone
                        ? "text-[var(--onboarding-text-subtle)]"
                        : "text-[var(--onboarding-text-faint)]"
                  }`}
                >
                  {t(step.subtitle)}
                </div>
              </div>
            </>
          );

          return (
            <li key={step.id} className="flex-1 list-none">
              {isClickable ? (
                <Button
                  variant="ghost"
                  type="button"
                  className={shellClass}
                  title={t(step.name)}
                  aria-label={`${t(step.name)} — ${t("onboarding.stepLabel", { current: index + 1, total: activeSteps.length })} (${t("onboarding.completed")})`}
                  onClick={() => handleOnboardingJumpToStep(step.id)}
                >
                  {content}
                </Button>
              ) : (
                <div
                  className={shellClass}
                  title={t(step.name)}
                  aria-label={`${t(step.name)} — ${t("onboarding.stepLabel", { current: index + 1, total: activeSteps.length })}`}
                  {...(isActive ? { "aria-current": "step" as const } : {})}
                >
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
