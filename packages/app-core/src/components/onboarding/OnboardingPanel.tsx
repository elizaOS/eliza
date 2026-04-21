import { type ReactNode, useEffect, useRef } from "react";
import type { OnboardingStep } from "../../state/types";

interface OnboardingPanelProps {
  step: OnboardingStep;
  children: ReactNode;
}

export const onboardingPanelSurfaceClassName =
  "border border-[var(--onboarding-panel-border)] bg-[var(--onboarding-panel-bg)] shadow-[var(--onboarding-panel-shadow)]";

export function OnboardingPanel({ step, children }: OnboardingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const prevStepRef = useRef(step);
  const widthClass =
    step === "providers"
      ? "max-w-[46rem]"
      : step === "deployment"
        ? "max-w-[34rem]"
        : "max-w-[38rem]";

  // Re-trigger entry animation on step change
  useEffect(() => {
    if (prevStepRef.current !== step && panelRef.current) {
      const panel = panelRef.current;
      panel.style.animation = "none";
      // Force reflow
      void panel.offsetHeight;
      panel.style.animation = "";

      // Re-trigger children stagger
      panel.querySelectorAll<HTMLElement>(":scope > *").forEach((child) => {
        child.style.animation = "none";
        void child.offsetHeight;
        child.style.animation = "";
      });
    }
    prevStepRef.current = step;
  }, [step]);

  return (
    <div className="relative flex w-full justify-center">
      <div
        className={`onboarding-panel relative flex max-h-[min(72dvh,calc(100dvh-9.75rem))] min-h-0 w-full ${widthClass} flex-col gap-0 overflow-x-hidden overflow-y-auto rounded-[28px] px-[clamp(1rem,3vw,1.5rem)] py-[clamp(1.25rem,3vw,2rem)] backdrop-blur-[36px] backdrop-saturate-[1.24] animate-[onboarding-panel-enter_0.6s_cubic-bezier(0.25,0.46,0.45,0.94)_both] max-md:max-h-[min(68dvh,calc(100dvh-10.5rem))] max-md:max-w-none max-md:rounded-2xl ${onboardingPanelSurfaceClassName}`}
        ref={panelRef}
      >
        {children}
      </div>
    </div>
  );
}
