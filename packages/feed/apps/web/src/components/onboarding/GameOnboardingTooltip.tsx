'use client';

import type { GameOnboardingStep } from '@feed/shared';
import { cn, ONBOARDING_STEP_ORDER } from '@feed/shared';
import { Check, ChevronRight, Sparkles, X } from 'lucide-react';
import { STEP_INFO, useGameOnboarding } from './GameOnboardingProvider';

/**
 * Props for GameOnboardingTooltip
 */
interface GameOnboardingTooltipProps {
  /** Step this tooltip is for */
  step: GameOnboardingStep;
  /** Position of the tooltip */
  position?: 'top' | 'bottom' | 'left' | 'right';
  /** Additional class names */
  className?: string;
  /** Children to wrap with tooltip */
  children: React.ReactNode;
}

/**
 * GameOnboardingTooltip
 *
 * Displays a contextual tooltip for a specific onboarding step.
 * Only shows when the step is the current step in the tutorial.
 */
export function GameOnboardingTooltip({
  step,
  position = 'bottom',
  className,
  children,
}: GameOnboardingTooltipProps) {
  const { currentTooltipStep, showTooltip, completeStep, skipOnboarding } =
    useGameOnboarding();

  const isActive = showTooltip && currentTooltipStep === step;
  const stepInfo = STEP_INFO[step];

  const positionClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  const arrowClasses = {
    top: 'top-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-b-transparent border-t-[var(--color-onboarding-primary)]',
    bottom:
      'bottom-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-t-transparent border-b-[var(--color-onboarding-primary)]',
    left: 'left-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-r-transparent border-l-[var(--color-onboarding-primary)]',
    right:
      'right-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-l-transparent border-r-[var(--color-onboarding-primary)]',
  };

  return (
    <div className={cn('relative', className)}>
      {children}

      {isActive && (
        <div
          className={cn(
            'fade-in slide-in-from-bottom-2 absolute z-50 w-72 animate-in duration-300',
            positionClasses[position]
          )}
        >
          {/* Arrow */}
          <div
            className={cn(
              'absolute h-0 w-0 border-8 border-solid',
              arrowClasses[position]
            )}
          />

          {/* Tooltip content */}
          <div className="rounded-xl border border-[var(--color-onboarding-primary)]/30 bg-gradient-to-br from-[var(--color-onboarding-primary)]/20 to-[var(--color-onboarding-primary)]/10 p-4 shadow-xl backdrop-blur-sm">
            <div className="mb-3 flex items-start justify-between">
              <div className="flex items-center gap-2">
                <div className="rounded-lg bg-[var(--color-onboarding-primary)]/20 p-1.5">
                  <Sparkles className="h-4 w-4 text-[var(--color-onboarding-primary)]" />
                </div>
                <span className="font-semibold text-sm">{stepInfo.title}</span>
              </div>
              <button
                onClick={() => void skipOnboarding()}
                className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Skip tutorial"
                aria-label="Skip tutorial"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mb-3 text-muted-foreground text-sm">
              {stepInfo.description}
            </p>

            <div className="flex items-center justify-between">
              <span className="font-medium text-[var(--color-onboarding-primary)] text-xs">
                +{stepInfo.points} reputation
              </span>
              <button
                onClick={() => void completeStep(step)}
                className="flex items-center gap-1 rounded-lg bg-[var(--color-onboarding-primary)] px-3 py-1.5 font-medium text-sm text-white transition-colors hover:bg-[var(--color-onboarding-primary)]/90"
              >
                <Check className="h-3.5 w-3.5" />
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * GameOnboardingProgress
 *
 * Shows the current progress through the onboarding tutorial.
 */
export function GameOnboardingProgress() {
  const { status, needsOnboarding, skipOnboarding } = useGameOnboarding();

  if (!needsOnboarding || !status) return null;

  // Use the shared step order, excluding the 'complete' marker step for UI display
  const steps = ONBOARDING_STEP_ORDER.filter(
    (step): step is Exclude<GameOnboardingStep, 'complete'> =>
      step !== 'complete'
  );

  const completedCount = status.completedSteps.length;
  const totalSteps = steps.length;
  const progress = totalSteps > 0 ? (completedCount / totalSteps) * 100 : 0;

  return (
    <div className="fixed right-4 bottom-4 z-40 w-80 rounded-xl border border-border bg-background/95 p-4 shadow-xl backdrop-blur-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--color-onboarding-primary)]" />
          <span className="font-semibold">Tutorial Progress</span>
        </div>
        <button
          onClick={() => void skipOnboarding()}
          className="text-muted-foreground text-xs hover:text-foreground hover:underline"
        >
          Skip
        </button>
      </div>

      {/* Progress bar */}
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[var(--color-onboarding-primary)] to-[#00AAFF] transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Steps list */}
      <div className="space-y-2">
        {steps.map((step) => {
          const info = STEP_INFO[step];
          const isCompleted = status.completedSteps.includes(step);
          const isCurrent = status.currentStep === step;

          return (
            <div
              key={step}
              className={cn(
                'flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors',
                isCompleted &&
                  'bg-[var(--color-onboarding-primary)]/10 text-[var(--color-onboarding-primary)]',
                isCurrent && !isCompleted && 'bg-muted',
                !isCompleted && !isCurrent && 'text-muted-foreground'
              )}
            >
              <div className="flex items-center gap-2">
                {isCompleted ? (
                  <Check className="h-4 w-4 text-[var(--color-onboarding-primary)]" />
                ) : isCurrent ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <div className="h-4 w-4 rounded-full border border-muted-foreground/30" />
                )}
                <span>{info.title}</span>
              </div>
              <span className="text-xs">+{info.points} rep</span>
            </div>
          );
        })}
      </div>

      {/* Reputation earned */}
      <div className="mt-3 border-border border-t pt-3 text-center">
        <span className="text-muted-foreground text-sm">
          Reputation earned:{' '}
        </span>
        <span className="font-bold text-[var(--color-onboarding-primary)]">
          {status.totalReputationEarned}
        </span>
      </div>
    </div>
  );
}
