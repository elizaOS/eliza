import { useState, useEffect } from 'react';
import clientLogger from '../lib/logger';

// Key for storing onboarding state in localStorage
const ONBOARDING_COMPLETED_KEY = 'eliza-onboarding-completed';

/**
 * Custom hook to manage the onboarding state
 * Tracks whether the user has completed the onboarding tour
 */
export const useOnboarding = () => {
  // Check if user has completed the onboarding
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean>(() => {
    try {
      // Try to get the stored value from localStorage
      const storedValue = localStorage.getItem(ONBOARDING_COMPLETED_KEY);
      return storedValue === 'true';
    } catch (error) {
      // If there's an error (e.g. localStorage not available), assume not completed
      clientLogger.error('Error accessing localStorage:', error);
      return false;
    }
  });

  // Update localStorage when onboardingCompleted changes
  useEffect(() => {
    try {
      localStorage.setItem(ONBOARDING_COMPLETED_KEY, onboardingCompleted.toString());
    } catch (error) {
      clientLogger.error('Error writing to localStorage:', error);
    }
  }, [onboardingCompleted]);

  // Function to mark onboarding as completed
  const completeOnboarding = () => {
    setOnboardingCompleted(true);
  };

  // Function to reset onboarding state (for testing)
  const resetOnboarding = () => {
    setOnboardingCompleted(false);
  };

  return {
    onboardingCompleted,
    completeOnboarding,
    resetOnboarding,
  };
};
