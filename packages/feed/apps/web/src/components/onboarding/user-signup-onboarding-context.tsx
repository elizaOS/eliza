'use client';

import type { OnboardingProfilePayload } from '@feed/shared';
import { createContext, useContext } from 'react';
import type { ImportedProfileData } from './UserOnboardingFlow';

export type OnboardingFlowPhase = 'profile' | 'guide';

export interface UserSignupOnboardingContextValue {
  phase: OnboardingFlowPhase;
  isReplayGuide: boolean;
  shouldShowOnboarding: boolean;
  /** True once the provider has finished initialising and shouldShowOnboarding is stable. */
  isOnboardingResolved: boolean;
  isSubmitting: boolean;
  guideSubmitting: boolean;
  error: string | null;
  onSubmitProfile: (payload: OnboardingProfilePayload) => Promise<void>;
  onGuideComplete: (options?: { nextHref?: string }) => Promise<void>;
  onLogout: () => Promise<void>;
  user: {
    id?: string;
    username?: string;
    walletAddress?: string;
  } | null;
  importedData: ImportedProfileData | null;
}

const UserSignupOnboardingContext =
  createContext<UserSignupOnboardingContextValue | null>(null);

export function UserSignupOnboardingContextProvider({
  value,
  children,
}: {
  value: UserSignupOnboardingContextValue;
  children: React.ReactNode;
}) {
  return (
    <UserSignupOnboardingContext.Provider value={value}>
      {children}
    </UserSignupOnboardingContext.Provider>
  );
}

export function useUserSignupOnboarding() {
  return useContext(UserSignupOnboardingContext);
}
