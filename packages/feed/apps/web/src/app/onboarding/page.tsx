'use client';

export const dynamic = 'force-dynamic';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { UserOnboardingFlow } from '@/components/onboarding/UserOnboardingFlow';
import { useUserSignupOnboarding } from '@/components/onboarding/user-signup-onboarding-context';
import { PageContainer } from '@/components/shared/PageContainer';
import { useAuth } from '@/hooks/useAuth';

export default function OnboardingPage() {
  const router = useRouter();
  const flow = useUserSignupOnboarding();
  const { ready, authenticated, login, loadingProfile, profileFetchStatus } =
    useAuth();

  useEffect(() => {
    if (!ready || authenticated) return;
    router.push('/feed');
    const timer = setTimeout(() => login(), 500);
    return () => clearTimeout(timer);
  }, [ready, authenticated, router, login]);

  useEffect(() => {
    if (!ready || !authenticated || loadingProfile) return;
    if (profileFetchStatus !== 'done') return;
    if (!flow) return;
    // Wait for the provider to finish initialising — avoids a one-tick race where
    // loadingProfile is already false but isReadyToShow hasn't been set yet.
    if (!flow.isOnboardingResolved) return;
    if (flow.shouldShowOnboarding) return;
    router.replace('/feed');
  }, [ready, authenticated, loadingProfile, profileFetchStatus, flow, router]);

  if (!ready || !authenticated) {
    return null;
  }

  // Show loading shell while profile is still resolving.
  // Once flow is ready and shouldShowOnboarding is true, skip straight to the flow.
  const stillResolving = loadingProfile || profileFetchStatus !== 'done';

  if (stillResolving) {
    return (
      <PageContainer noPadding>
        <div
          className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6"
          aria-busy="true"
          aria-live="polite"
        >
          <Loader2
            className="h-8 w-8 animate-spin text-muted-foreground"
            aria-hidden
          />
          <p className="text-muted-foreground text-sm">Loading…</p>
        </div>
      </PageContainer>
    );
  }

  if (!flow?.shouldShowOnboarding) {
    return null;
  }

  return (
    <PageContainer noPadding>
      <UserOnboardingFlow
        phase={flow.phase}
        isReplayGuide={flow.isReplayGuide}
        isSubmitting={flow.isSubmitting}
        guideSubmitting={flow.guideSubmitting}
        error={flow.error}
        onSubmitProfile={flow.onSubmitProfile}
        onGuideComplete={flow.onGuideComplete}
        onLogout={flow.onLogout}
        user={flow.user}
        importedData={flow.importedData}
      />
    </PageContainer>
  );
}
