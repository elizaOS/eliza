'use client';

import type { GameOnboardingStep } from '@babylon/shared';
import { logger, ONBOARDING_STEP_INFO } from '@babylon/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { apiFetch } from '@/utils/api-fetch';

/**
 * Onboarding status from API
 */
interface OnboardingStatus {
  currentStep: GameOnboardingStep;
  completedSteps: GameOnboardingStep[];
  totalReputationEarned: number;
  isComplete: boolean;
}

/**
 * Type-guard to validate OnboardingStatus shape at runtime
 */
function isValidOnboardingStatus(data: unknown): data is OnboardingStatus {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.currentStep === 'string' &&
    Array.isArray(obj.completedSteps) &&
    typeof obj.totalReputationEarned === 'number' &&
    typeof obj.isComplete === 'boolean'
  );
}

/**
 * Game onboarding context value
 */
interface GameOnboardingContextValue {
  status: OnboardingStatus | null;
  isLoading: boolean;
  completeStep: (step: GameOnboardingStep) => Promise<void>;
  skipOnboarding: () => Promise<void>;
  needsOnboarding: boolean;
  showTooltip: boolean;
  setShowTooltip: (show: boolean) => void;
  currentTooltipStep: GameOnboardingStep | null;
}

const GameOnboardingContext = createContext<GameOnboardingContextValue | null>(
  null
);

/**
 * Step display information - imported from shared package
 */
export const STEP_INFO = ONBOARDING_STEP_INFO;

/**
 * Game Onboarding Provider
 *
 * Provides context for the game tutorial system.
 */
export function GameOnboardingProvider({
  children,
  userId,
}: {
  children: React.ReactNode;
  userId?: string;
}) {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showTooltip, setShowTooltip] = useState(false);

  // Fetch onboarding status on mount
  useEffect(() => {
    if (!userId) {
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();

    const fetchStatus = async () => {
      try {
        const response = await apiFetch('/api/onboarding/game-status', {
          signal: controller.signal,
        });
        // Skip state updates if the request was aborted
        if (controller.signal.aborted) return;

        if (response.ok) {
          const data = await response.json();
          // Validate response shape before using
          if (isValidOnboardingStatus(data)) {
            setStatus(data);
            // Show tooltip if not complete
            if (!data.isComplete) {
              setShowTooltip(true);
            }
          } else {
            logger.error(
              'Invalid onboarding status response shape',
              { data },
              'GameOnboardingProvider'
            );
          }
        }
      } catch (error) {
        // Skip state updates if this was an abort error
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        // Onboarding is optional, but log errors for debugging
        logger.error(
          'Failed to fetch onboarding status',
          error instanceof Error ? error : { error },
          'GameOnboardingProvider'
        );
      } finally {
        // Only update loading state if not aborted
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void fetchStatus();

    return () => {
      controller.abort();
    };
  }, [userId]);

  // Complete a step
  const completeStep = useCallback(async (step: GameOnboardingStep) => {
    try {
      const response = await apiFetch('/api/onboarding/game-complete-step', {
        method: 'POST',
        body: JSON.stringify({ step }),
      });

      if (response.ok) {
        const rawData: unknown = await response.json();

        // Runtime validation of response shape
        if (
          typeof rawData !== 'object' ||
          rawData === null ||
          typeof (rawData as Record<string, unknown>).success !== 'boolean' ||
          typeof (rawData as Record<string, unknown>).reputationAwarded !==
            'number' ||
          typeof (rawData as Record<string, unknown>).nextStep !== 'string' ||
          typeof (rawData as Record<string, unknown>).isComplete !== 'boolean'
        ) {
          logger.error(
            'Invalid response shape from game-complete-step API',
            { rawData },
            'GameOnboardingProvider'
          );
          return;
        }

        const data = rawData as {
          success: boolean;
          reputationAwarded: number;
          nextStep: GameOnboardingStep;
          isComplete: boolean;
        };

        if (data.success) {
          setStatus((prev) => {
            if (!prev) return null;
            // Guard against duplicate step additions
            if (prev.completedSteps.includes(step)) {
              return prev;
            }
            return {
              ...prev,
              completedSteps: [...prev.completedSteps, step],
              currentStep: data.nextStep,
              totalReputationEarned:
                prev.totalReputationEarned + data.reputationAwarded,
              isComplete: data.isComplete,
            };
          });
        }
      }
    } catch (error) {
      // Onboarding is optional, but log errors for debugging
      logger.error(
        'Failed to complete onboarding step',
        error instanceof Error ? error : { error },
        'GameOnboardingProvider'
      );
    }
  }, []);

  // Skip onboarding
  const skipOnboarding = useCallback(async () => {
    try {
      const response = await apiFetch('/api/onboarding/game-skip', {
        method: 'POST',
      });
      if (response.ok) {
        setStatus((prev) =>
          prev ? { ...prev, isComplete: true, completedSteps: [] } : null
        );
        setShowTooltip(false);
      } else {
        // Log non-OK responses so failures are visible
        const responseText = await response
          .text()
          .catch(() => '(failed to read body)');
        logger.error(
          'Skip onboarding request failed',
          {
            status: response.status,
            statusText: response.statusText,
            body: responseText,
          },
          'GameOnboardingProvider'
        );
      }
    } catch (error) {
      logger.error(
        'Failed to skip onboarding',
        error instanceof Error ? error : { error },
        'GameOnboardingProvider'
      );
    }
  }, []);

  const needsOnboarding =
    !!userId && !isLoading && !!status && !status.isComplete;
  const currentTooltipStep = needsOnboarding
    ? (status?.currentStep ?? null)
    : null;

  // Memoize context value to prevent unnecessary re-renders
  const contextValue = useMemo(
    () => ({
      status,
      isLoading,
      completeStep,
      skipOnboarding,
      needsOnboarding,
      showTooltip,
      setShowTooltip,
      currentTooltipStep,
    }),
    [
      status,
      isLoading,
      completeStep,
      skipOnboarding,
      needsOnboarding,
      showTooltip,
      currentTooltipStep,
    ]
  );

  return (
    <GameOnboardingContext.Provider value={contextValue}>
      {children}
    </GameOnboardingContext.Provider>
  );
}

/**
 * Hook to access game onboarding context
 */
export function useGameOnboarding(): GameOnboardingContextValue {
  const context = useContext(GameOnboardingContext);
  if (!context) {
    throw new Error(
      'useGameOnboarding must be used within a GameOnboardingProvider'
    );
  }
  return context;
}
