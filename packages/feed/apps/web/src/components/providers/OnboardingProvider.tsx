'use client';

import type { OnboardingProfilePayload } from '@feed/shared';
import {
  isValidOnboardingUsername,
  logger,
  POINTS,
  sanitizeOnboardingUsername,
} from '@feed/shared';
// Phase 2: Privy replaced by Steward — no more usePrivy or useIdentityToken
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImportedProfileData } from '@/components/onboarding/UserOnboardingFlow';
import { UserSignupOnboardingContextProvider } from '@/components/onboarding/user-signup-onboarding-context';
import { useAuth } from '@/hooks/useAuth';
import { useSignupTracking } from '@/hooks/usePostHog';
import {
  hasCompletedGameGuide,
  markGameGuideCompletedLocal,
} from '@/lib/game-guide-completion';
import { useAuthStore } from '@/stores/authStore';
import { apiFetch } from '@/utils/api-fetch';

import { clearReferralCode, getReferralCode } from './ReferralCaptureProvider';

function getSafeReturnTo(): string {
  if (typeof window === 'undefined') return '/feed';
  const raw = new URLSearchParams(window.location.search).get('returnTo');
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/feed';
  }
  return raw;
}

/**
 * Unified first-run flow: profile signup + game guide on `/onboarding` (full page).
 * Optional `?replayGuide=1` re-opens the tour from the user menu.
 */
export function OnboardingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const {
    authenticated,
    user,
    needsOnboarding,
    loadingProfile,
    profileFetchStatus,
    logout,
  } = useAuth();

  // Phase 2: isSocialLogin derived from the Feed user record (populated at login)
  const isSocialLogin = useMemo(() => {
    return !!(user?.hasFarcaster || user?.hasTwitter);
  }, [user]);

  const { setUser, setNeedsOnboarding } = useAuthStore();
  const { trackSignupStarted, trackSignupCompleted, trackOnboardingStep } =
    useSignupTracking();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [guideSubmitting, setGuideSubmitting] = useState(false);
  const guideCompleteInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [_submittedProfile, setSubmittedProfile] =
    useState<OnboardingProfilePayload | null>(null);
  const [importedProfileData, setImportedProfileData] =
    useState<ImportedProfileData | null>(null);
  const [_hasProgressedPastSocialImport, setHasProgressedPastSocialImport] =
    useState(false);
  const socialAutoSubmitRef = useRef(false);
  const [socialAutoSubmitAttempted, setSocialAutoSubmitAttempted] =
    useState(false);

  const [isReadyToShow, setIsReadyToShow] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);

  const [replayGuide, setReplayGuide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setReplayGuide(
      pathname === '/onboarding' &&
        new URLSearchParams(window.location.search).get('replayGuide') === '1'
    );
  }, [pathname]);

  const guideDone = useMemo(
    () => hasCompletedGameGuide(user?.id, user?.gameGuideCompletedAt),
    [user?.id, user?.gameGuideCompletedAt]
  );

  useEffect(() => {
    if (!authenticated || loadingProfile) {
      setIsReadyToShow(false);
      setHasInitialized(false);
      return;
    }

    if (hasInitialized) {
      setIsReadyToShow(true);
      return;
    }

    // Shorter delay in dev avoids a sluggish redirect while Turbopack compiles.
    const delay = process.env.NODE_ENV === 'development' ? 0 : 1000;
    const timer = setTimeout(() => {
      setIsReadyToShow(true);
      setHasInitialized(true);
    }, delay);

    return () => clearTimeout(timer);
  }, [authenticated, loadingProfile, hasInitialized]);

  useEffect(() => {
    if (
      needsOnboarding &&
      authenticated &&
      !loadingProfile &&
      profileFetchStatus === 'done'
    ) {
      setIsReadyToShow(true);
      setHasInitialized(true);
    }
  }, [needsOnboarding, authenticated, loadingProfile, profileFetchStatus]);

  const shouldShowOnboarding = useMemo(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const isDevMode = params.get('dev') === 'true';
      const isProduction = window.location.hostname === 'feed.market';
      const isHomePage = window.location.pathname === '/';
      const isWaitlistFlow = params.get('waitlist') === 'true';

      if (isProduction && isHomePage && !isDevMode && !isWaitlistFlow) {
        return false;
      }
    }

    if (!isReadyToShow) {
      return false;
    }

    if (!authenticated || loadingProfile) {
      return false;
    }

    if (profileFetchStatus !== 'done') {
      return false;
    }

    if (user?.isActor) {
      return false;
    }

    if (replayGuide) {
      return true;
    }

    if (needsOnboarding) {
      return true;
    }

    if (!guideDone) {
      return true;
    }

    return false;
  }, [
    isReadyToShow,
    authenticated,
    loadingProfile,
    profileFetchStatus,
    user,
    replayGuide,
    needsOnboarding,
    guideDone,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!shouldShowOnboarding) return;
    if (pathname === '/onboarding' || pathname.startsWith('/onboarding/')) {
      return;
    }

    const currentParams = new URLSearchParams(window.location.search);
    const next = new URLSearchParams();
    const returnPath = `${pathname}${window.location.search}`;
    if (returnPath && returnPath !== '/onboarding') {
      next.set('returnTo', returnPath);
    }
    if (currentParams.get('waitlist') === 'true') {
      next.set('waitlist', 'true');
    }
    if (currentParams.get('dev') === 'true') {
      next.set('dev', 'true');
    }
    const q = next.toString();
    router.replace(`/onboarding${q ? `?${q}` : ''}`);
  }, [shouldShowOnboarding, pathname, router]);

  const phase = useMemo<'profile' | 'guide'>(() => {
    if (replayGuide) return 'guide';
    if (needsOnboarding) return 'profile';
    return 'guide';
  }, [replayGuide, needsOnboarding]);

  const handleProfileSubmit = useCallback(
    async (payload: OnboardingProfilePayload) => {
      setIsSubmitting(true);
      setError(null);
      trackSignupStarted();

      const referralCode = getReferralCode();

      try {
        const response = await apiFetch('/api/users/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            referralCode: referralCode ?? undefined,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          const message =
            data?.error ||
            `Failed to complete signup (status ${response.status})`;
          setIsSubmitting(false);
          throw new Error(message);
        }

        if (data.user) {
          const u = data.user as {
            id: string;
            walletAddress?: string;
            displayName?: string;
            username?: string;
            bio?: string;
            profileImageUrl?: string;
            coverImageUrl?: string;
            profileComplete?: boolean;
            reputationPoints?: number;
            hasFarcaster?: boolean;
            hasTwitter?: boolean;
            farcasterUsername?: string;
            twitterUsername?: string;
            nftTokenId?: number;
            createdAt?: string;
            gameGuideCompletedAt?: string | null;
          };
          setUser({
            id: u.id,
            displayName:
              u.displayName ?? payload.displayName ?? payload.username,
            email: user?.email,
            username: u.username ?? payload.username,
            bio: u.bio ?? payload.bio,
            profileImageUrl:
              u.profileImageUrl ?? payload.profileImageUrl ?? undefined,
            coverImageUrl:
              u.coverImageUrl ?? payload.coverImageUrl ?? undefined,
            profileComplete: u.profileComplete ?? true,
            reputationPoints: u.reputationPoints ?? user?.reputationPoints,
            hasFarcaster: u.hasFarcaster ?? user?.hasFarcaster,
            hasTwitter: u.hasTwitter ?? user?.hasTwitter,
            farcasterUsername: u.farcasterUsername ?? user?.farcasterUsername,
            twitterUsername: u.twitterUsername ?? user?.twitterUsername,
            createdAt: u.createdAt ?? user?.createdAt,
            gameGuideCompletedAt: u.gameGuideCompletedAt ?? null,
          });
        }
        setNeedsOnboarding(false);

        clearReferralCode();
        setSubmittedProfile(payload);
        trackOnboardingStep('profile', true);
        trackSignupCompleted(data.user?.id ?? '', {
          hasReferrer: Boolean(referralCode),
          hasFarcaster: data.user?.hasFarcaster ?? false,
          hasTwitter: data.user?.hasTwitter ?? false,
        });
        setIsSubmitting(false);
      } catch (err) {
        setIsSubmitting(false);
        throw err;
      }
    },
    [
      user,
      setUser,
      setNeedsOnboarding,
      trackSignupStarted,
      trackSignupCompleted,
      trackOnboardingStep,
    ]
  );

  useEffect(() => {
    if (!authenticated) {
      setSubmittedProfile(null);
      setError(null);
      setImportedProfileData(null);
      setHasProgressedPastSocialImport(false);
      socialAutoSubmitRef.current = false;
      setSocialAutoSubmitAttempted(false);
      return;
    }

    if (loadingProfile) {
      return;
    }

    if (needsOnboarding) {
      if (
        isSocialLogin &&
        importedProfileData &&
        !socialAutoSubmitRef.current &&
        !socialAutoSubmitAttempted
      ) {
        setSocialAutoSubmitAttempted(true);
        socialAutoSubmitRef.current = true;
        logger.info(
          'Social login user - auto-submitting profile',
          {
            platform: importedProfileData.platform,
            username: importedProfileData.username,
          },
          'OnboardingProvider'
        );
        const sanitizedUsername = sanitizeOnboardingUsername(
          importedProfileData.username
        );
        if (!isValidOnboardingUsername(sanitizedUsername)) {
          logger.warn(
            'Social username not valid after sanitization, falling back to manual onboarding',
            {
              raw: importedProfileData.username,
              sanitized: sanitizedUsername,
            },
            'OnboardingProvider'
          );
          socialAutoSubmitRef.current = false;
          return;
        }
        const autoProfile: OnboardingProfilePayload = {
          username: sanitizedUsername,
          displayName: importedProfileData.displayName,
          bio: '',
          profileImageUrl: importedProfileData.profileImageUrl ?? undefined,
          coverImageUrl: undefined,
          importedFrom: importedProfileData.platform,
          twitterId: importedProfileData.twitterId ?? null,
          twitterUsername:
            importedProfileData.platform === 'twitter'
              ? importedProfileData.username
              : null,
          farcasterFid: importedProfileData.farcasterFid ?? null,
          farcasterUsername:
            importedProfileData.platform === 'farcaster'
              ? importedProfileData.username
              : null,
          tosAccepted: true,
          privacyPolicyAccepted: true,
        };
        handleProfileSubmit(autoProfile).catch((submitError: Error) => {
          logger.error(
            'Social login auto-submit failed',
            {
              error: submitError.message,
              platform: importedProfileData.platform,
            },
            'OnboardingProvider'
          );
          setError(submitError.message);
          socialAutoSubmitRef.current = false;
        });
        return;
      }
    }
  }, [
    authenticated,
    loadingProfile,
    needsOnboarding,
    isSocialLogin,
    importedProfileData,
    handleProfileSubmit,
    socialAutoSubmitAttempted,
  ]);

  // Phase 2: Auto-import social profile from Feed user record
  // Social data (farcasterUsername, twitterUsername, etc.) is populated at login
  // by the Farcaster/Twitter auth routes before this effect runs.
  useEffect(() => {
    if (!authenticated || !needsOnboarding || !user) return;
    if (importedProfileData) return;
    if (loadingProfile) return;

    if (user.hasFarcaster && user.farcasterUsername) {
      const profileData: ImportedProfileData = {
        platform: 'farcaster',
        username: user.farcasterUsername,
        displayName: user.displayName || user.farcasterUsername,
        bio: user.bio || undefined,
        profileImageUrl: user.profileImageUrl || null,
        farcasterFid: undefined,
      };

      logger.info(
        'Auto-imported Farcaster profile from Feed user record',
        {
          username: profileData.username,
          expectedPoints: POINTS.FARCASTER_LINK,
        },
        'OnboardingProvider'
      );

      setImportedProfileData(profileData);
      setHasProgressedPastSocialImport(true);
      return;
    }

    if (user.hasTwitter && user.twitterUsername) {
      const profileData: ImportedProfileData = {
        platform: 'twitter',
        username: user.twitterUsername,
        displayName: user.displayName || user.twitterUsername,
        bio: undefined,
        profileImageUrl: user.profileImageUrl || null,
        twitterId: undefined,
      };

      logger.info(
        'Auto-imported Twitter profile from Feed user record',
        { username: profileData.username, expectedPoints: POINTS.TWITTER_LINK },
        'OnboardingProvider'
      );

      setImportedProfileData(profileData);
      setHasProgressedPastSocialImport(true);
    }
  }, [
    authenticated,
    user,
    needsOnboarding,
    importedProfileData,
    loadingProfile,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined' || !authenticated) return;

    const params = new URLSearchParams(window.location.search);
    const socialImport = params.get('social_import');
    const dataParam = params.get('data');

    if (socialImport && dataParam) {
      try {
        const parsed = JSON.parse(decodeURIComponent(dataParam)) as unknown;

        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('platform' in parsed) ||
          !('username' in parsed) ||
          !('displayName' in parsed) ||
          (parsed.platform !== 'twitter' && parsed.platform !== 'farcaster') ||
          typeof parsed.username !== 'string' ||
          typeof parsed.displayName !== 'string'
        ) {
          logger.warn(
            'Invalid social profile data structure from URL',
            { socialImport },
            'OnboardingProvider'
          );
          return;
        }

        const profileData = parsed as ImportedProfileData;
        logger.info(
          'Social profile data received from URL',
          { platform: socialImport },
          'OnboardingProvider'
        );

        setImportedProfileData(profileData);
        setHasProgressedPastSocialImport(true);
      } catch (parseError) {
        logger.warn(
          'Failed to parse social profile data from URL',
          { error: parseError },
          'OnboardingProvider'
        );
      }

      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('social_import');
      newUrl.searchParams.delete('data');
      window.history.replaceState({}, '', newUrl.toString());
    }
  }, [authenticated]);

  const handleGuideComplete = useCallback(
    async (options?: { nextHref?: string }) => {
      if (guideCompleteInFlight.current) return;
      const uid = user?.id;
      const dest = options?.nextHref ?? getSafeReturnTo();

      if (!uid) {
        router.replace(dest);
        return;
      }

      guideCompleteInFlight.current = true;
      setGuideSubmitting(true);
      markGameGuideCompletedLocal(uid);

      try {
        const res = await apiFetch('/api/users/me/game-guide', {
          method: 'POST',
        });
        if (res.ok) {
          const { gameGuideCompletedAt } = (await res.json()) as {
            gameGuideCompletedAt: string;
          };
          const fresh = useAuthStore.getState().user;
          if (fresh) {
            setUser({ ...fresh, gameGuideCompletedAt });
          }
          logger.info(
            'Unified onboarding: game guide marked complete',
            { userId: uid },
            'OnboardingProvider'
          );
        } else {
          logger.error(
            'Game guide API failed (localStorage backup saved)',
            { status: res.status, userId: uid },
            'OnboardingProvider'
          );
        }
      } catch (err) {
        logger.error(
          'Game guide API error',
          {
            error: err instanceof Error ? err.message : String(err),
            userId: uid,
          },
          'OnboardingProvider'
        );
      } finally {
        setGuideSubmitting(false);
        guideCompleteInFlight.current = false;
      }

      trackOnboardingStep('guide', true);
      router.replace(dest);
    },
    [user?.id, router, setUser, trackOnboardingStep]
  );

  const onLogout = useCallback(async () => {
    if (logout) {
      await logout();
    }
  }, [logout]);

  const flowContextValue = useMemo(
    () => ({
      phase,
      isReplayGuide: replayGuide,
      shouldShowOnboarding,
      isOnboardingResolved: isReadyToShow,
      isSubmitting,
      guideSubmitting,
      error,
      onSubmitProfile: handleProfileSubmit,
      onGuideComplete: handleGuideComplete,
      onLogout,
      user,
      importedData: importedProfileData,
    }),
    [
      phase,
      replayGuide,
      shouldShowOnboarding,
      isReadyToShow,
      isSubmitting,
      guideSubmitting,
      error,
      handleProfileSubmit,
      handleGuideComplete,
      onLogout,
      user,
      importedProfileData,
    ]
  );

  return (
    <UserSignupOnboardingContextProvider value={flowContextValue}>
      {children}
    </UserSignupOnboardingContextProvider>
  );
}
