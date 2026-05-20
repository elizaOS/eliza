'use client';

import type { OnboardingProfilePayload } from '@babylon/shared';
import {
  cn,
  getAgentDefaultProfileImageUrl,
  logger,
  sanitizeOnboardingUsername,
  TOTAL_AGENT_DEFAULT_PROFILE_PICTURES,
} from '@babylon/shared';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
} from 'lucide-react';
import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiFetch } from '@/utils/api-fetch';
import { uploadImage, validateImageFile } from '@/utils/upload-image';

import { GAME_GUIDE_SLIDES } from './game-guide-slides';

/**
 * Imported profile data structure from social platforms.
 */
export interface ImportedProfileData {
  platform: 'twitter' | 'farcaster';
  username: string;
  displayName: string;
  bio?: string;
  profileImageUrl?: string | null;
  coverImageUrl?: string | null;
  twitterId?: string;
  farcasterFid?: string;
}

const PROFILE_FORM_ID = 'user-onboarding-profile-form';

const GUIDE_CONTAINER_VARIANTS = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.1 },
  },
  exit: {},
};

const GUIDE_ITEM_VARIANTS = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3 } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.15 } },
};

// Instant (no motion) variants for users who prefer reduced motion
const GUIDE_ITEM_VARIANTS_REDUCED = {
  hidden: { opacity: 0, y: 0 },
  visible: { opacity: 1, y: 0, transition: { duration: 0 } },
  exit: { opacity: 0, y: 0, transition: { duration: 0 } },
};

interface UserOnboardingFlowProps {
  phase: 'profile' | 'guide';
  isReplayGuide: boolean;
  isSubmitting: boolean;
  guideSubmitting: boolean;
  error?: string | null;
  onSubmitProfile: (payload: OnboardingProfilePayload) => Promise<void>;
  onGuideComplete: (options?: { nextHref?: string }) => Promise<void>;
  onLogout?: () => Promise<void>;
  user: {
    id?: string;
    username?: string;
    walletAddress?: string;
  } | null;
  importedData?: ImportedProfileData | null;
}

interface GeneratedProfileResponse {
  name: string;
  username: string;
  bio: string;
}

interface RandomAssetsResponse {
  profilePictureIndex: number;
  bannerIndex: number;
}

const TOTAL_BANNERS = 100;
const ABSOLUTE_URL_PATTERN = /^(https?:|data:|blob:)/i;

function resolveAssetUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  if (ABSOLUTE_URL_PATTERN.test(value)) {
    return value;
  }
  if (typeof window !== 'undefined' && value.startsWith('/')) {
    return new URL(value, window.location.origin).toString();
  }
  return value;
}

export function UserOnboardingFlow({
  phase,
  isReplayGuide,
  isSubmitting,
  guideSubmitting,
  error,
  onSubmitProfile,
  onGuideComplete,
  onLogout,
  user,
  importedData,
}: UserOnboardingFlowProps) {
  const [username, setUsername] = useState('');
  const [profilePictureIndex, setProfilePictureIndex] = useState(1);
  const [bannerIndex, setBannerIndex] = useState(1);
  const [uploadedProfileFile, setUploadedProfileFile] = useState<File | null>(
    null
  );
  const [uploadedProfileImage, setUploadedProfileImage] = useState<
    string | null
  >(null);
  const [uploadedBanner, setUploadedBanner] = useState<string | null>(null);
  const [isCheckingUsername, setIsCheckingUsername] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState<
    'available' | 'taken' | null
  >(null);
  const [usernameSuggestion, setUsernameSuggestion] = useState<string | null>(
    null
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [isLoadingDefaults, setIsLoadingDefaults] = useState(true);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const flowRootRef = useRef<HTMLDivElement>(null);

  const prefersReducedMotion = useReducedMotion();
  const activeGuideItemVariants = prefersReducedMotion
    ? GUIDE_ITEM_VARIANTS_REDUCED
    : GUIDE_ITEM_VARIANTS;

  const [guideSlide, setGuideSlide] = useState(0);
  const [guideDirection, setGuideDirection] = useState(0);

  const guideSlideData = GAME_GUIDE_SLIDES[guideSlide];
  const isFirstGuideSlide = guideSlide === 0;
  const isLastGuideSlide = guideSlide === GAME_GUIDE_SLIDES.length - 1;

  const currentProfileImage = useMemo(() => {
    return (
      uploadedProfileImage ||
      getAgentDefaultProfileImageUrl(profilePictureIndex)
    );
  }, [uploadedProfileImage, profilePictureIndex]);

  const currentBanner = useMemo(() => {
    return uploadedBanner || `/assets/user-banners/banner-${bannerIndex}.jpg`;
  }, [uploadedBanner, bannerIndex]);

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (phase !== 'guide') return;
    setGuideSlide(0);
    setGuideDirection(0);
  }, [phase]);

  useEffect(() => {
    if (!importedData || phase !== 'profile') return;

    logger.info(
      'Pre-filling profile with imported data',
      {
        platform: importedData.platform,
        hasProfileImage: !!importedData.profileImageUrl,
        hasCoverImage: !!importedData.coverImageUrl,
      },
      'UserOnboardingFlow'
    );

    setUsername(sanitizeOnboardingUsername(importedData.username));
    setUploadedProfileFile(null);
    if (importedData.profileImageUrl) {
      setUploadedProfileImage(importedData.profileImageUrl);
    } else {
      setUploadedProfileImage(null);
      setProfilePictureIndex(
        Math.floor(Math.random() * TOTAL_AGENT_DEFAULT_PROFILE_PICTURES) + 1
      );
    }
    setUploadedBanner(null);
    setBannerIndex(Math.floor(Math.random() * TOTAL_BANNERS) + 1);
  }, [importedData, phase]);

  useEffect(() => {
    if (phase !== 'profile') return;

    if (importedData) {
      setIsLoadingDefaults(false);
      return;
    }

    const initializeProfile = async () => {
      setIsLoadingDefaults(true);

      const [profileResult, assetsResult] = await Promise.allSettled([
        apiFetch('/api/onboarding/generate-profile', { auth: false }),
        apiFetch('/api/onboarding/random-assets', { auth: false }),
      ]);

      if (profileResult.status === 'fulfilled' && profileResult.value.ok) {
        const generated =
          (await profileResult.value.json()) as GeneratedProfileResponse;
        setUsername(generated.username);
      } else {
        setUsername(`user_${Math.random().toString(36).slice(2, 10)}`);
      }

      if (assetsResult.status === 'fulfilled' && assetsResult.value.ok) {
        const assets =
          (await assetsResult.value.json()) as RandomAssetsResponse;
        setProfilePictureIndex(assets.profilePictureIndex);
        setBannerIndex(assets.bannerIndex);
      } else {
        setProfilePictureIndex(
          Math.floor(Math.random() * TOTAL_AGENT_DEFAULT_PROFILE_PICTURES) + 1
        );
        setBannerIndex(Math.floor(Math.random() * TOTAL_BANNERS) + 1);
      }

      setUploadedProfileFile(null);
      setUploadedProfileImage(null);
      setUploadedBanner(null);
      setIsLoadingDefaults(false);
    };

    void initializeProfile();
  }, [phase, importedData]);

  useEffect(() => {
    if (phase !== 'profile') return;
    if (!username || username.length < 3) {
      setUsernameStatus(null);
      setUsernameSuggestion(null);
      return;
    }

    let cancelled = false;

    const checkUsername = async () => {
      setIsCheckingUsername(true);
      let status: 'available' | 'taken' | null = null;
      let suggestion: string | null = null;

      const response = await apiFetch(
        `/api/onboarding/check-username?username=${encodeURIComponent(username)}`,
        { auth: false }
      ).catch((checkError: Error) => {
        logger.warn(
          'Username availability check error',
          { error: checkError },
          'UserOnboardingFlow'
        );
        return null;
      });

      if (response?.ok) {
        const result = (await response.json()) as {
          available?: boolean;
          suggestion?: string;
        };
        status = result.available ? 'available' : 'taken';
        suggestion = result.available ? null : (result.suggestion ?? null);
      } else if (response) {
        const body = await response.json();
        logger.warn(
          'Username availability check failed',
          { status: response.status, body },
          'UserOnboardingFlow'
        );
      }

      if (!cancelled) {
        setUsernameStatus(status);
        setUsernameSuggestion(suggestion);
        setIsCheckingUsername(false);
      }
    };

    const debounceTimer = setTimeout(() => {
      void checkUsername();
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
    };
  }, [username, phase]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (phase !== 'profile' || isSubmitting) return;

    setFormError(null);

    if (!username.trim() || username.length < 3) {
      setFormError('Please pick a username of at least 3 characters');
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      setFormError(
        'Username can only contain letters, numbers, and underscores'
      );
      return;
    }

    if (usernameStatus === 'taken') {
      setFormError('Username is already taken. Please choose another.');
      return;
    }

    if (!acceptedTerms) {
      setFormError(
        'Please accept the Terms of Service and Privacy Policy to continue'
      );
      return;
    }

    let profileImageUrl: string | undefined;
    if (uploadedProfileFile) {
      try {
        profileImageUrl = await uploadImage(uploadedProfileFile, 'profile');
      } catch (err) {
        setFormError(
          err instanceof Error ? err.message : 'Failed to upload profile image'
        );
        return;
      }
    } else {
      profileImageUrl = resolveAssetUrl(
        uploadedProfileImage ??
          getAgentDefaultProfileImageUrl(profilePictureIndex)
      );
    }

    const trimmedUsername = username.trim().toLowerCase();
    const profilePayload: OnboardingProfilePayload = {
      username: trimmedUsername,
      displayName: trimmedUsername,
      bio: '',
      profileImageUrl,
      coverImageUrl: resolveAssetUrl(
        uploadedBanner ?? `/assets/user-banners/banner-${bannerIndex}.jpg`
      ),
      importedFrom: importedData?.platform || null,
      twitterId:
        importedData?.platform === 'twitter' ? importedData.twitterId : null,
      twitterUsername:
        importedData?.platform === 'twitter' ? importedData.username : null,
      farcasterFid:
        importedData?.platform === 'farcaster'
          ? importedData.farcasterFid
          : null,
      farcasterUsername:
        importedData?.platform === 'farcaster' ? importedData.username : null,
      tosAccepted: acceptedTerms,
      privacyPolicyAccepted: acceptedTerms,
    };

    await onSubmitProfile(profilePayload);
  };

  const cycleProfilePicture = (direction: 'next' | 'prev') => {
    setUploadedProfileFile(null);
    setUploadedProfileImage(null);
    setProfilePictureIndex((prev) => {
      if (direction === 'next') {
        return prev >= TOTAL_AGENT_DEFAULT_PROFILE_PICTURES ? 1 : prev + 1;
      }
      return prev <= 1 ? TOTAL_AGENT_DEFAULT_PROFILE_PICTURES : prev - 1;
    });
  };

  const handleProfileImageUpload = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const validationError = validateImageFile(file);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setUploadedProfileFile(file);
      setUploadedProfileImage(reader.result as string);
      setFormError(null);
    };
    reader.onerror = () => {
      logger.error('Failed to read image file', {}, 'UserOnboardingFlow');
      setFormError('Failed to read image file. Please try again.');
      setUploadedProfileFile(null);
      setUploadedProfileImage(null);
    };
    reader.readAsDataURL(file);
  };

  const canLogout = !isSubmitting && !guideSubmitting && onLogout;

  const handleLogout = async () => {
    if (onLogout) {
      await onLogout();
    }
  };

  const goGuideNext = useCallback(() => {
    if (guideSubmitting) return;
    if (isLastGuideSlide) {
      void onGuideComplete();
    } else {
      setGuideDirection(1);
      setGuideSlide((s) => s + 1);
    }
  }, [guideSubmitting, isLastGuideSlide, onGuideComplete]);

  const goGuidePrev = useCallback(() => {
    if (guideSubmitting) return;
    if (!isFirstGuideSlide) {
      setGuideDirection(-1);
      setGuideSlide((s) => s - 1);
    }
  }, [guideSubmitting, isFirstGuideSlide]);

  const handleGuideSkip = useCallback(() => {
    if (guideSubmitting) return;
    void onGuideComplete();
  }, [guideSubmitting, onGuideComplete]);

  const handleGuideCta = useCallback(
    (href: string) => {
      void onGuideComplete({ nextHref: href });
    },
    [onGuideComplete]
  );

  useEffect(() => {
    if (phase !== 'guide' || guideSubmitting) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleGuideSkip();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') goGuideNext();
      else if (e.key === 'ArrowLeft') goGuidePrev();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [phase, guideSubmitting, goGuideNext, goGuidePrev, handleGuideSkip]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (phase !== 'profile' || !flowRootRef.current) return;
      if (e.key !== 'Tab') return;

      const focusableElements =
        flowRootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (!firstElement || !lastElement) return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement.focus();
        }
      } else if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    },
    [phase]
  );

  useEffect(() => {
    if (phase !== 'profile') return;

    document.addEventListener('keydown', handleKeyDown);

    const timer = setTimeout(() => {
      if (flowRootRef.current) {
        const firstFocusable = flowRootRef.current.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        firstFocusable?.focus();
      }
    }, 100);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [phase, handleKeyDown]);

  const profileFormFields = (
    <form
      id={PROFILE_FORM_ID}
      onSubmit={handleSubmit}
      className="space-y-8 p-6 md:p-8"
    >
      <div className="relative -mx-6 -mt-6 h-32 overflow-hidden bg-muted md:-mx-8 md:-mt-8 md:h-40">
        <Image
          src={currentBanner}
          alt="Profile banner"
          fill
          className="object-cover"
          unoptimized
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent" />
      </div>

      <div className="-mt-16 flex flex-col items-center md:-mt-20">
        <div className="group relative h-28 w-28 overflow-hidden rounded-full border-4 border-background bg-muted shadow-lg md:h-32 md:w-32">
          <Image
            src={currentProfileImage}
            alt="Profile picture"
            fill
            className="object-cover"
            unoptimized
            priority
          />
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
            <button
              type="button"
              onClick={() => cycleProfilePicture('prev')}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-background/90 shadow-sm transition-transform hover:bg-background active:scale-95"
              aria-label="Previous avatar"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <label className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full bg-background/90 shadow-sm transition-transform hover:bg-background active:scale-95">
              <Upload className="h-5 w-5" />
              <input
                type="file"
                accept="image/*"
                onChange={handleProfileImageUpload}
                className="hidden"
              />
              <span className="sr-only">Upload avatar</span>
            </label>
            <button
              type="button"
              onClick={() => cycleProfilePicture('next')}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-background/90 shadow-sm transition-transform hover:bg-background active:scale-95"
              aria-label="Next avatar"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        </div>
        <p className="mt-3 text-center text-muted-foreground text-xs">
          Choose an avatar or upload your own
        </p>
      </div>

      <div className="mx-auto w-full max-w-sm space-y-3 px-2">
        <label htmlFor="username" className="block text-center font-medium">
          Choose your username
        </label>
        <div className="relative">
          <span className="absolute top-1/2 left-4 -translate-y-1/2 font-medium text-muted-foreground">
            @
          </span>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) =>
              setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))
            }
            placeholder="your_username"
            className={cn(
              'w-full rounded-xl border-2 bg-muted px-4 py-3.5 pr-12 pl-9 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#0066FF] focus:ring-offset-2',
              usernameStatus === 'available' && 'border-green-500/50',
              usernameStatus === 'taken' && 'border-red-500/50',
              !usernameStatus && 'border-border'
            )}
            maxLength={20}
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
          />
          <div className="absolute top-1/2 right-4 -translate-y-1/2">
            {isCheckingUsername && (
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
            {usernameStatus === 'available' && !isCheckingUsername && (
              <Check className="h-5 w-5 text-green-500" />
            )}
            {usernameStatus === 'taken' && !isCheckingUsername && (
              <AlertCircle className="h-5 w-5 text-red-500" />
            )}
          </div>
        </div>
        {usernameStatus === 'taken' && usernameSuggestion && (
          <p className="text-center text-muted-foreground text-sm">
            Username taken. Try:{' '}
            <button
              type="button"
              className="font-medium text-[#0066FF] hover:underline"
              onClick={() => setUsername(usernameSuggestion)}
            >
              @{usernameSuggestion}
            </button>
          </p>
        )}
        {usernameStatus === 'available' && !isCheckingUsername && (
          <p className="text-center text-green-600 text-sm">
            ✓ Username available
          </p>
        )}
        {!usernameStatus && username.length < 3 && username.length > 0 && (
          <p className="text-center text-muted-foreground text-sm">
            Username must be at least 3 characters
          </p>
        )}
        {!usernameStatus && username.length === 0 && (
          <p className="text-center text-muted-foreground text-sm">
            This will be your unique handle on Babylon
          </p>
        )}
      </div>

      {(formError || error) && (
        <div className="mx-auto flex max-w-sm items-center justify-center gap-2 text-red-500 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{formError || error}</span>
        </div>
      )}

      <div className="mx-auto w-full max-w-sm space-y-5 px-2">
        <label className="group flex cursor-pointer items-start gap-3 rounded-lg p-2 transition-colors hover:bg-muted/50 active:bg-muted/70">
          <input
            type="checkbox"
            checked={acceptedTerms}
            onChange={(e) => setAcceptedTerms(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-border text-[#0066FF] focus:ring-2 focus:ring-[#0066FF] focus:ring-offset-2"
          />
          <span className="text-muted-foreground text-sm leading-relaxed group-hover:text-foreground">
            I accept the{' '}
            <a
              href="https://docs.babylon.market/legal/terms-of-service/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[#0066FF] hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              Terms of Service
            </a>{' '}
            and{' '}
            <a
              href="https://docs.babylon.market/legal/privacy-policy/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[#0066FF] hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              Privacy Policy
            </a>
          </span>
        </label>
      </div>
    </form>
  );

  const guideBody =
    phase === 'guide' && guideSlideData ? (
      <div className="flex min-h-[min(50vh,420px)] flex-col px-6 py-8 md:px-10">
        <p className="mb-6 text-center text-muted-foreground text-xs uppercase tracking-widest">
          Getting started
        </p>
        <div className="mb-6 flex justify-center gap-2">
          {GAME_GUIDE_SLIDES.map((_, i) => (
            <div
              key={i}
              className={cn(
                'h-2 rounded-full transition-all duration-200',
                i === guideSlide
                  ? 'w-6 bg-[#0066FF]'
                  : i < guideSlide
                    ? 'w-2 bg-[#0066FF]/50'
                    : 'w-2 bg-muted-foreground/30'
              )}
            />
          ))}
        </div>
        <AnimatePresence mode="wait" custom={guideDirection}>
          <motion.div
            key={guideSlide}
            variants={GUIDE_CONTAINER_VARIANTS}
            initial="hidden"
            animate="visible"
            exit="exit"
            className="flex flex-1 flex-col items-center text-center"
            aria-live="polite"
            aria-atomic="true"
          >
            <motion.h2
              variants={activeGuideItemVariants}
              className="mb-4 font-bold text-2xl tracking-tight md:text-3xl"
            >
              {guideSlideData.title}
            </motion.h2>
            <motion.p
              variants={activeGuideItemVariants}
              className="max-w-md text-foreground/80 text-sm leading-relaxed sm:text-base"
            >
              {guideSlideData.description}
            </motion.p>
            {guideSlideData.ctas && (
              <motion.div
                variants={activeGuideItemVariants}
                className="mt-8 flex w-full max-w-md flex-col gap-3 sm:flex-row sm:justify-center"
              >
                {guideSlideData.ctas.map((cta, i) => (
                  <button
                    key={cta.href}
                    type="button"
                    disabled={guideSubmitting}
                    onClick={() => handleGuideCta(cta.href)}
                    className={cn(
                      'rounded-xl px-5 py-3 font-medium text-sm transition-colors',
                      i === 0
                        ? 'bg-[#0066FF] text-primary-foreground hover:bg-[#0066FF]/90'
                        : 'border border-border text-foreground hover:bg-muted',
                      guideSubmitting && 'cursor-not-allowed opacity-50'
                    )}
                  >
                    {cta.label}
                  </button>
                ))}
              </motion.div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    ) : null;

  const progressFooter = (
    <div className="mx-auto flex w-full max-w-xs items-center justify-center gap-3">
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full font-medium text-xs transition-all',
            phase === 'profile'
              ? 'bg-[#0066FF] text-white'
              : 'bg-green-500 text-white'
          )}
        >
          {phase === 'profile' ? '1' : <Check className="h-3.5 w-3.5" />}
        </div>
        <span className="hidden text-xs sm:inline">Profile</span>
      </div>

      <div
        className={cn(
          'h-0.5 w-8 rounded-full transition-colors',
          phase === 'guide' ? 'bg-[#0066FF]/60' : 'bg-muted'
        )}
      />

      <div className="flex items-center gap-2">
        <div
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full font-medium text-xs transition-all',
            phase === 'guide'
              ? 'bg-[#0066FF] text-white'
              : 'bg-muted text-muted-foreground'
          )}
        >
          2
        </div>
        <span className="hidden text-xs sm:inline">Tour</span>
      </div>
    </div>
  );

  const canSubmitProfile =
    !isSubmitting &&
    usernameStatus !== 'taken' &&
    acceptedTerms &&
    username.length >= 3;

  const headerTitle =
    phase === 'profile'
      ? 'Set up your profile'
      : isReplayGuide
        ? 'Game guide'
        : 'Welcome to Babylon';

  return (
    <div
      ref={flowRootRef}
      className={cn(
        'flex min-h-dvh flex-col bg-background pb-safe transition-opacity duration-300',
        isVisible ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div className="flex shrink-0 items-center justify-between border-border border-b px-4 py-4 pt-safe md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="shrink-0 rounded-lg bg-[#0066FF]/10 p-2">
            <Sparkles className="h-5 w-5 text-[#0066FF] md:h-6 md:w-6" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-bold text-lg md:text-xl">
              {headerTitle}
            </h1>
            {phase === 'profile' && importedData && (
              <p className="text-[#0066FF] text-xs">
                Imported from{' '}
                {importedData.platform === 'twitter' ? '𝕏' : 'Farcaster'}
              </p>
            )}
            {phase === 'guide' && !isReplayGuide && (
              <p className="text-muted-foreground text-xs">
                Quick tour — then you&apos;re in
              </p>
            )}
            {phase === 'guide' && isReplayGuide && (
              <p className="text-muted-foreground text-xs">
                Replay anytime from your menu
              </p>
            )}
            {user?.username && phase === 'profile' && (
              <p className="truncate text-muted-foreground text-xs">
                @{user.username}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {phase === 'guide' && (
            <button
              type="button"
              onClick={handleGuideSkip}
              disabled={guideSubmitting}
              className={cn(
                'rounded-lg px-3 py-2 text-muted-foreground text-sm hover:bg-muted hover:text-foreground',
                guideSubmitting && 'cursor-not-allowed opacity-40'
              )}
            >
              Skip
            </button>
          )}
          {canLogout && (
            <button
              type="button"
              onClick={handleLogout}
              className="shrink-0 rounded-lg px-3 py-2 text-muted-foreground text-sm hover:bg-muted hover:text-foreground active:bg-muted/80"
              disabled={isSubmitting}
            >
              Logout
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:mx-auto md:w-full md:max-w-3xl md:rounded-lg md:border md:border-border">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-lg">
            {phase === 'guide' ? (
              guideBody
            ) : isLoadingDefaults ? (
              <div className="flex flex-col items-center p-6 md:p-8">
                <Skeleton className="-mx-6 -mt-6 h-32 w-[calc(100%+48px)] md:-mx-8 md:-mt-8 md:h-40 md:w-[calc(100%+64px)]" />
                <Skeleton className="-mt-14 h-28 w-28 rounded-full border-4 border-background md:-mt-16 md:h-32 md:w-32" />
                <div className="mt-6 w-full max-w-sm space-y-4">
                  <Skeleton className="mx-auto h-6 w-40" />
                  <Skeleton className="h-14 w-full rounded-xl" />
                  <Skeleton className="mx-auto h-4 w-48" />
                </div>
                <div className="mt-6 w-full max-w-sm space-y-4">
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-14 w-full rounded-xl" />
                </div>
              </div>
            ) : (
              profileFormFields
            )}
          </div>
        </div>

        <div className="shrink-0 space-y-4 border-border border-t bg-background px-4 py-4 sm:px-6">
          {progressFooter}
          {phase === 'profile' && !isLoadingDefaults && (
            <button
              type="submit"
              form={PROFILE_FORM_ID}
              className={cn(
                'w-full rounded-xl bg-[#0066FF] px-6 py-4 font-semibold text-white shadow-lg transition-all hover:bg-[#0055DD] hover:shadow-xl active:scale-[0.98]',
                !canSubmitProfile && 'cursor-not-allowed opacity-50'
              )}
              disabled={!canSubmitProfile}
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <RefreshCw className="h-5 w-5 animate-spin" />
                  Creating Profile...
                </span>
              ) : (
                'Continue'
              )}
            </button>
          )}
          {phase === 'guide' && (
            <div className="flex items-center justify-between gap-3">
              {!isFirstGuideSlide ? (
                <button
                  type="button"
                  onClick={goGuidePrev}
                  disabled={guideSubmitting}
                  className={cn(
                    'flex items-center gap-1 font-medium text-sm transition-colors',
                    guideSubmitting
                      ? 'cursor-not-allowed text-muted-foreground/40'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={goGuideNext}
                disabled={guideSubmitting}
                className={cn(
                  'flex min-w-[140px] items-center justify-center gap-2 rounded-xl bg-[#0066FF] px-6 py-4 font-semibold text-primary-foreground text-sm transition-colors',
                  guideSubmitting
                    ? 'cursor-not-allowed opacity-70'
                    : 'hover:bg-[#0066FF]/90'
                )}
              >
                {guideSubmitting ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Saving...
                  </>
                ) : isLastGuideSlide ? (
                  'Start playing'
                ) : (
                  <>
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
