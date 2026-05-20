'use client';

import {
  cn,
  getAgentDefaultProfileImageUrl,
  parseAgentPresetProfileIndex,
  TOTAL_AGENT_DEFAULT_PROFILE_PICTURES,
} from '@babylon/shared';
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Upload,
  X as XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { uploadImage, validateImageFile } from '@/utils/upload-image';
import type { ProfileFormData } from '../hooks/useAgentForm';
import { useAgentUsernameCheck } from '../hooks/useAgentUsernameCheck';

const TOTAL_BANNERS = 100;
const MAX_BIO_LENGTH = 160;

interface AgentSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  profileData: ProfileFormData;
  onSave: (data: ProfileFormData) => void;
  /** When true, hides the close button to prevent no-op clicks */
  hideCloseButton?: boolean;
}

export function AgentSetupModal({
  isOpen,
  onClose,
  profileData,
  onSave,
  hideCloseButton = false,
}: AgentSetupModalProps) {
  const [localData, setLocalData] = useState<ProfileFormData>(profileData);
  const bioInitialized = useRef(false);

  // Reset bio initialization flag when modal closes so new data can sync on reopen
  useEffect(() => {
    if (!isOpen) {
      bioInitialized.current = false;
    }
  }, [isOpen]);

  // Sync bio from profileData when template loads (bio comes from template.description)
  // Truncate to MAX_BIO_LENGTH characters if needed
  // Uses ref to track initialization so user can clear bio without it being re-synced
  useEffect(() => {
    if (profileData.bio && !bioInitialized.current) {
      setLocalData((prev) => ({
        ...prev,
        bio: profileData.bio.slice(0, MAX_BIO_LENGTH),
      }));
      bioInitialized.current = true;
    }
  }, [profileData.bio]);

  // Username availability check
  const { usernameStatus, usernameSuggestion, isCheckingUsername, retryCheck } =
    useAgentUsernameCheck(localData.username);
  const [uploadedProfileFile, setUploadedProfileFile] = useState<File | null>(
    null
  );
  const [uploadedBannerFile, setUploadedBannerFile] = useState<File | null>(
    null
  );
  const [isUploading, setIsUploading] = useState(false);
  const [profilePictureIndex, setProfilePictureIndex] = useState(() => {
    return parseAgentPresetProfileIndex(profileData.profileImageUrl) ?? 1;
  });
  const [bannerIndex, setBannerIndex] = useState(() => {
    // Extract index from URL if it's a local asset
    const match = profileData.coverImageUrl?.match(/banner-(\d+)\.jpg/);
    return match?.[1] ? parseInt(match[1], 10) : 1;
  });
  const [uploadedProfileImage, setUploadedProfileImage] = useState<
    string | null
  >(
    profileData.profileImageUrl?.startsWith('/assets/')
      ? null
      : profileData.profileImageUrl || null
  );
  const [uploadedBanner, setUploadedBanner] = useState<string | null>(
    profileData.coverImageUrl?.startsWith('/assets/')
      ? null
      : profileData.coverImageUrl || null
  );

  const profileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // Computed current images
  const currentProfileImage = useMemo(() => {
    return (
      uploadedProfileImage ||
      getAgentDefaultProfileImageUrl(profilePictureIndex)
    );
  }, [uploadedProfileImage, profilePictureIndex]);

  const currentBanner = useMemo(() => {
    return uploadedBanner || `/assets/user-banners/banner-${bannerIndex}.jpg`;
  }, [uploadedBanner, bannerIndex]);

  // Cycle profile picture
  const cycleProfilePicture = useCallback((direction: 'next' | 'prev') => {
    setUploadedProfileImage(null);
    setUploadedProfileFile(null);
    setProfilePictureIndex((prev) => {
      if (direction === 'next') {
        return prev >= TOTAL_AGENT_DEFAULT_PROFILE_PICTURES ? 1 : prev + 1;
      }
      return prev <= 1 ? TOTAL_AGENT_DEFAULT_PROFILE_PICTURES : prev - 1;
    });
  }, []);

  // Cycle banner
  const cycleBanner = useCallback((direction: 'next' | 'prev') => {
    setUploadedBanner(null);
    setUploadedBannerFile(null);
    setBannerIndex((prev) => {
      if (direction === 'next') {
        return prev >= TOTAL_BANNERS ? 1 : prev + 1;
      }
      return prev <= 1 ? TOTAL_BANNERS : prev - 1;
    });
  }, []);

  const handleProfileImageUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const validationError = validateImageFile(file);
      if (validationError) {
        toast.error(validationError);
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setUploadedProfileFile(file);
        setUploadedProfileImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    },
    []
  );

  const handleBannerUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const validationError = validateImageFile(file);
      if (validationError) {
        toast.error(validationError);
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setUploadedBannerFile(file);
        setUploadedBanner(reader.result as string);
      };
      reader.readAsDataURL(file);
    },
    []
  );

  const handleContinue = async () => {
    if (!localData.username.trim()) {
      toast.error('Username is required');
      return;
    }
    if (localData.username.length < 3) {
      toast.error('Username must be at least 3 characters');
      return;
    }
    if (usernameStatus !== 'available') {
      toast.error('Please choose an available username');
      return;
    }
    if (!localData.displayName.trim()) {
      toast.error('Display name is required');
      return;
    }

    setIsUploading(true);
    try {
      let profileImageUrl = currentProfileImage;
      let coverImageUrl = currentBanner;

      if (uploadedProfileFile) {
        try {
          profileImageUrl = await uploadImage(uploadedProfileFile, 'profile');
        } catch {
          toast.error('Failed to upload profile image');
          return;
        }
      }

      if (uploadedBannerFile) {
        try {
          coverImageUrl = await uploadImage(uploadedBannerFile, 'cover');
        } catch {
          toast.error('Failed to upload cover image');
          return;
        }
      }

      onSave({
        ...localData,
        profileImageUrl,
        coverImageUrl,
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleUseSuggestion = useCallback(() => {
    if (usernameSuggestion) {
      setLocalData((prev) => ({ ...prev, username: usernameSuggestion }));
    }
  }, [usernameSuggestion]);

  const isContinueDisabled =
    !localData.displayName.trim() ||
    !localData.username.trim() ||
    localData.username.length < 3 ||
    usernameStatus !== 'available' ||
    isCheckingUsername ||
    isUploading;

  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape to close
  useEffect(() => {
    if (!isOpen || hideCloseButton) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, hideCloseButton, onClose]);

  // Focus first focusable element on open
  useEffect(() => {
    if (!isOpen || !dialogRef.current) return;
    const firstFocusable = dialogRef.current.querySelector<HTMLElement>(
      'input, button:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])'
    );
    firstFocusable?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-0 backdrop-blur-sm md:p-4"
      onClick={!hideCloseButton ? onClose : undefined}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-setup-title"
        className="relative flex h-full w-full flex-col bg-background md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[600px] md:max-w-3xl md:rounded-lg md:border md:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header - fixed */}
        <div className="shrink-0 border-border border-b px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center justify-between">
            <h2 id="agent-setup-title" className="font-bold text-lg">
              Set Up Your Agent
            </h2>
            {!hideCloseButton && (
              <button
                onClick={onClose}
                className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <XIcon className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>

        {/* Content - scrollable */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
          {/* Profile Images Section */}
          <div className="relative mb-14 sm:mb-16">
            {/* Banner */}
            <div className="group relative h-24 overflow-hidden rounded-lg bg-muted sm:h-32">
              <img
                src={currentBanner}
                alt="Profile banner"
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => cycleBanner('prev')}
                  aria-label="Previous banner"
                  className="rounded-full bg-background/90 p-1.5 hover:bg-background sm:p-2"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <label
                  className="cursor-pointer rounded-full bg-background/90 p-1.5 hover:bg-background sm:p-2"
                  aria-label="Upload banner image"
                >
                  <Upload className="h-4 w-4" />
                  <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleBannerUpload}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => cycleBanner('next')}
                  aria-label="Next banner"
                  className="rounded-full bg-background/90 p-1.5 hover:bg-background sm:p-2"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Avatar - overlapping banner */}
            <div className="absolute -bottom-12 left-3 sm:-bottom-14 sm:left-4">
              <div className="group relative h-24 w-24 overflow-hidden rounded-full border-4 border-background bg-muted sm:h-28 sm:w-28">
                <img
                  src={currentProfileImage}
                  alt="Profile picture"
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/40 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => cycleProfilePicture('prev')}
                    aria-label="Previous avatar"
                    className="rounded-full bg-background/90 p-1 hover:bg-background sm:p-1.5"
                  >
                    <ChevronLeft className="h-3 w-3 sm:h-4 sm:w-4" />
                  </button>
                  <label
                    className="cursor-pointer rounded-full bg-background/90 p-1 hover:bg-background sm:p-1.5"
                    aria-label="Upload avatar"
                  >
                    <Upload className="h-3 w-3 sm:h-4 sm:w-4" />
                    <input
                      ref={profileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleProfileImageUpload}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => cycleProfilePicture('next')}
                    aria-label="Next avatar"
                    className="rounded-full bg-background/90 p-1 hover:bg-background sm:p-1.5"
                  >
                    <ChevronRight className="h-3 w-3 sm:h-4 sm:w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Image upload info */}
          <p className="mb-4 text-muted-foreground text-xs">
            Tap images to browse or upload custom.
            <br />
            Max 5MB, JPG/PNG/GIF/WebP.
          </p>

          {/* Form Fields */}
          <div className="space-y-5">
            {/* Username */}
            <div>
              <label
                htmlFor="edit-username"
                className="mb-2 block font-medium text-sm"
              >
                Username *
              </label>
              <div
                className={cn(
                  'flex items-center rounded-lg border bg-muted focus-within:ring-2 focus-within:ring-[#0066FF]',
                  usernameStatus === 'taken' && 'border-red-500',
                  usernameStatus === 'error' && 'border-yellow-500',
                  usernameStatus === 'available' && 'border-green-500',
                  !usernameStatus && 'border-border'
                )}
              >
                <span className="px-4 text-muted-foreground">@</span>
                <input
                  id="edit-username"
                  type="text"
                  value={localData.username}
                  onChange={(e) =>
                    setLocalData((prev) => ({
                      ...prev,
                      username: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_]/g, ''),
                    }))
                  }
                  maxLength={20}
                  className="w-full bg-transparent py-3 pr-10 focus:outline-none"
                  placeholder="agent_username"
                  aria-invalid={
                    usernameStatus === 'taken' || usernameStatus === 'error'
                  }
                  aria-describedby="username-status username-help"
                />
                {/* Status indicator */}
                <div className="pr-3">
                  {isCheckingUsername && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                  {!isCheckingUsername && usernameStatus === 'available' && (
                    <Check className="h-4 w-4 text-green-500" />
                  )}
                  {!isCheckingUsername && usernameStatus === 'taken' && (
                    <XIcon className="h-4 w-4 text-red-500" />
                  )}
                  {!isCheckingUsername && usernameStatus === 'error' && (
                    <AlertCircle className="h-4 w-4 text-yellow-500" />
                  )}
                </div>
              </div>
              {/* Suggestion */}
              {usernameStatus === 'taken' && usernameSuggestion && (
                <p className="mt-1.5 text-muted-foreground text-xs">
                  Username taken. Try:{' '}
                  <button
                    type="button"
                    onClick={handleUseSuggestion}
                    className="text-primary underline hover:text-primary/80"
                  >
                    {usernameSuggestion}
                  </button>
                </p>
              )}
              {/* Error with retry */}
              {usernameStatus === 'error' && (
                <p className="mt-1.5 text-xs text-yellow-600">
                  Failed to check username.{' '}
                  <button
                    type="button"
                    onClick={retryCheck}
                    className="underline hover:text-yellow-500"
                  >
                    Retry
                  </button>
                </p>
              )}
              {localData.username && localData.username.length < 3 && (
                <p id="username-status" className="mt-1.5 text-red-500 text-xs">
                  Username must be at least 3 characters
                </p>
              )}
              <p
                id="username-help"
                className="mt-1.5 text-muted-foreground text-xs"
              >
                3-20 characters. Letters, numbers, and underscores only.
              </p>
            </div>

            {/* Display Name */}
            <div>
              <label
                htmlFor="edit-displayName"
                className="mb-2 block font-medium text-sm"
              >
                Display Name *
              </label>
              <input
                id="edit-displayName"
                type="text"
                value={localData.displayName}
                onChange={(e) =>
                  setLocalData((prev) => ({
                    ...prev,
                    displayName: e.target.value,
                  }))
                }
                className={cn(
                  'w-full rounded-lg border border-border bg-muted px-4 py-3',
                  'focus:outline-none focus:ring-2 focus:ring-[#0066FF]'
                )}
                placeholder="My Awesome Agent"
              />
            </div>

            {/* Bio */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="edit-bio" className="block font-medium text-sm">
                  Bio
                </label>
                <span className="text-muted-foreground text-xs">
                  {localData.bio?.length ?? 0}/{MAX_BIO_LENGTH}
                </span>
              </div>
              <textarea
                id="edit-bio"
                value={localData.bio ?? ''}
                onChange={(e) =>
                  setLocalData((prev) => ({ ...prev, bio: e.target.value }))
                }
                maxLength={MAX_BIO_LENGTH}
                rows={3}
                aria-describedby="bio-help"
                className={cn(
                  'w-full resize-none rounded-lg border border-border bg-muted px-4 py-3',
                  'focus:outline-none focus:ring-2 focus:ring-[#0066FF]'
                )}
                placeholder="A short description of your agent..."
              />
              <p id="bio-help" className="mt-1.5 text-muted-foreground text-xs">
                This will appear on your agent's profile.
              </p>
            </div>
          </div>
        </div>

        {/* Footer - fixed */}
        <div className="shrink-0 border-border border-t px-4 py-3 sm:px-6 sm:py-4">
          <button
            onClick={handleContinue}
            disabled={isContinueDisabled}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-xl px-4 py-4 font-semibold transition-all',
              'bg-[#0066FF] text-primary-foreground hover:bg-[#0055DD] hover:shadow-lg active:scale-[0.98]',
              'disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Uploading…
              </>
            ) : (
              'Continue'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
