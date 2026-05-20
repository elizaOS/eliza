'use client';

export const dynamic = 'force-dynamic';

import { cn, logger } from '@babylon/shared';
import {
  AlertCircle,
  Bell,
  Camera,
  CheckCircle2,
  Key,
  Link as LinkIcon,
  Monitor,
  Moon,
  Palette,
  Receipt,
  Save,
  Shield,
  Sun,
  User,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useMemo, useState } from 'react';
import { LoginButton } from '@/components/auth/LoginButton';
import { LinkSocialAccountsModal } from '@/components/profile/LinkSocialAccountsModal';
import { ApiKeysTab } from '@/components/settings/ApiKeysTab';
import { BillingTab } from '@/components/settings/BillingTab';
import { NotificationsTab } from '@/components/settings/NotificationsTab';
import { PrivacyTab } from '@/components/settings/PrivacyTab';
import { SecurityTab } from '@/components/settings/SecurityTab';
import { Avatar } from '@/components/shared/Avatar';
import { PageContainer } from '@/components/shared/PageContainer';
import { Skeleton } from '@/components/shared/Skeleton';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { apiUrl } from '@/utils/api-url';
import { uploadImage, validateImageFile } from '@/utils/upload-image';

/**
 * Check if billing feature is enabled
 * Feature flag: NEXT_PUBLIC_BILLING_ENABLED
 */
function isBillingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BILLING_ENABLED === 'true';
}

const themeOptions = [
  {
    value: 'light',
    label: 'Light',
    description: 'Light background with dark text',
    icon: Sun,
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Dark background with light text',
    icon: Moon,
  },
  {
    value: 'system',
    label: 'System',
    description: 'Match your system settings',
    icon: Monitor,
  },
] as const;

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { ready, authenticated, refresh, getAccessToken } = useAuth();
  const { user, setUser } = useAuthStore();
  const [activeTab, setActiveTab] = useState(() => {
    // Check for tab parameter in URL
    const tab = searchParams?.get('tab');
    return tab || 'profile';
  });

  // Sync tab changes with URL
  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId);
    router.replace(`/settings?tab=${tabId}`, { scroll: false });
  };

  // Sync tab when URL changes (e.g., browser back/forward)
  useEffect(() => {
    const tab = searchParams?.get('tab');
    if (tab && tab !== activeTab) {
      setActiveTab(tab);
    }
  }, [searchParams, activeTab]);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showLinkAccountsModal, setShowLinkAccountsModal] = useState(false);
  // Profile settings state
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [username, setUsername] = useState(user?.username || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [profileImage, setProfileImage] = useState<{
    file: File | null;
    preview: string | null;
  }>({ file: null, preview: null });
  const [coverImage, setCoverImage] = useState<{
    file: File | null;
    preview: string | null;
  }>({ file: null, preview: null });
  const [socialVisibility, setSocialVisibility] = useState<{
    twitter: boolean;
    farcaster: boolean;
    wallet: boolean;
  }>({
    twitter: user?.showTwitterPublic ?? true,
    farcaster: user?.showFarcasterPublic ?? true,
    wallet: user?.showWalletPublic ?? true,
  });
  const [emailNotificationPreferences, setEmailNotificationPreferences] =
    useState<{
      enabled: boolean;
      realtime: boolean;
      dailySummary: boolean;
      weeklySummary: boolean;
      monthlySummary: boolean;
    }>({
      enabled: user?.emailNotificationsEnabled ?? false,
      realtime: user?.emailNotificationsRealtime ?? true,
      dailySummary: user?.emailNotificationsDailySummary ?? true,
      weeklySummary: user?.emailNotificationsWeeklySummary ?? true,
      monthlySummary: user?.emailNotificationsMonthlySummary ?? true,
    });

  // Theme settings - connected to next-themes
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Check if billing is enabled via feature flag
  // Must be before any early returns to satisfy Rules of Hooks
  const billingEnabled = isBillingEnabled();

  // Build tabs array - billing is feature-flagged
  // Must be before any early returns to satisfy Rules of Hooks
  const tabs = useMemo(() => {
    const baseTabs = [
      { id: 'profile', label: 'Profile', icon: User },
      { id: 'theme', label: 'Theme', icon: Palette },
      { id: 'notifications', label: 'Notifications', icon: Bell },
    ];

    // Add billing tab if feature flag is enabled
    if (billingEnabled) {
      baseTabs.push({ id: 'billing', label: 'Billing', icon: Receipt });
    }

    // Add remaining tabs
    baseTabs.push(
      { id: 'security', label: 'Security', icon: Shield },
      { id: 'privacy', label: 'Privacy', icon: Shield },
      { id: 'api', label: 'API Keys', icon: Key }
    );

    return baseTabs;
  }, [billingEnabled]);

  // Wait for hydration to avoid SSR mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  // Calculate time remaining until username can be changed again
  const getUsernameChangeTimeRemaining = (): {
    canChange: boolean;
    hours: number;
    minutes: number;
  } | null => {
    if (!user?.usernameChangedAt)
      return { canChange: true, hours: 0, minutes: 0 };

    const lastChangeTime = new Date(user.usernameChangedAt).getTime();
    const now = Date.now();
    const hoursSinceChange = (now - lastChangeTime) / (1000 * 60 * 60);
    const hoursRemaining = 24 - hoursSinceChange;

    if (hoursRemaining <= 0) {
      return { canChange: true, hours: 0, minutes: 0 };
    }

    return {
      canChange: false,
      hours: Math.floor(hoursRemaining),
      minutes: Math.floor((hoursRemaining - Math.floor(hoursRemaining)) * 60),
    };
  };

  const usernameChangeLimit = getUsernameChangeTimeRemaining();

  // Sync profile fields when user data changes
  useEffect(() => {
    setDisplayName(user?.displayName ?? '');
    setUsername(user?.username ?? '');
    setBio(user?.bio ?? '');
    setSocialVisibility({
      twitter: user?.showTwitterPublic ?? true,
      farcaster: user?.showFarcasterPublic ?? true,
      wallet: user?.showWalletPublic ?? true,
    });
    setEmailNotificationPreferences({
      enabled: user?.emailNotificationsEnabled ?? false,
      realtime: user?.emailNotificationsRealtime ?? true,
      dailySummary: user?.emailNotificationsDailySummary ?? true,
      weeklySummary: user?.emailNotificationsWeeklySummary ?? true,
      monthlySummary: user?.emailNotificationsMonthlySummary ?? true,
    });
  }, [
    user?.displayName,
    user?.username,
    user?.bio,
    user?.showTwitterPublic,
    user?.showFarcasterPublic,
    user?.showWalletPublic,
    user?.emailNotificationsEnabled,
    user?.emailNotificationsRealtime,
    user?.emailNotificationsDailySummary,
    user?.emailNotificationsWeeklySummary,
    user?.emailNotificationsMonthlySummary,
  ]);

  const currentProfileImageUrl =
    profileImage.preview || user?.profileImageUrl || null;
  const currentCoverImageUrl =
    coverImage.preview || user?.coverImageUrl || null;

  const handleImageSelect = (file: File, type: 'profile' | 'cover'): void => {
    const validationError = validateImageFile(file);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      if (type === 'profile') {
        setProfileImage({ file, preview: reader.result as string });
      } else {
        setCoverImage({ file, preview: reader.result as string });
      }
      setErrorMessage(null);
    };
    reader.readAsDataURL(file);
  };

  const updateSocialVisibility = async (
    platform: 'twitter' | 'farcaster' | 'wallet',
    visible: boolean
  ) => {
    if (!user?.id) return;
    const token = await getAccessToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(
      apiUrl(`/api/users/${encodeURIComponent(user.id)}/update-visibility`),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ platform, visible }),
      }
    );

    const payload = (await response.json().catch(() => ({}))) as {
      visibility?: { twitter?: boolean; farcaster?: boolean; wallet?: boolean };
      error?: { message?: string };
    };

    if (!response.ok || !payload.visibility) {
      const message =
        payload?.error?.message || 'Unable to update visibility preferences.';
      setErrorMessage(message);
      return;
    }

    setSocialVisibility({
      twitter: payload.visibility.twitter ?? socialVisibility.twitter,
      farcaster: payload.visibility.farcaster ?? socialVisibility.farcaster,
      wallet: payload.visibility.wallet ?? socialVisibility.wallet,
    });

    setUser({
      ...user,
      showTwitterPublic: payload.visibility.twitter ?? user.showTwitterPublic,
      showFarcasterPublic:
        payload.visibility.farcaster ?? user.showFarcasterPublic,
      showWalletPublic: payload.visibility.wallet ?? user.showWalletPublic,
    });
  };

  const updateEmailNotificationPreferences = async (
    patch: Partial<{
      enabled: boolean;
      realtime: boolean;
      dailySummary: boolean;
      weeklySummary: boolean;
      monthlySummary: boolean;
    }>
  ) => {
    if (!user?.id) return;

    const token = await getAccessToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(
      `/api/users/${encodeURIComponent(user.id)}/notification-email-preferences`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(patch),
      }
    );

    const payload = (await response.json().catch(() => ({}))) as {
      preferences?: {
        enabled?: boolean;
        realtime?: boolean;
        dailySummary?: boolean;
        weeklySummary?: boolean;
        monthlySummary?: boolean;
      };
      email?: string | null;
      emailVerified?: boolean;
      error?: { message?: string } | string;
    };

    if (!response.ok || !payload.preferences) {
      const fallbackMessage =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error?.message;
      setErrorMessage(
        fallbackMessage || 'Unable to update notification email preferences.'
      );
      return;
    }

    setEmailNotificationPreferences({
      enabled:
        payload.preferences.enabled ?? emailNotificationPreferences.enabled,
      realtime:
        payload.preferences.realtime ?? emailNotificationPreferences.realtime,
      dailySummary:
        payload.preferences.dailySummary ??
        emailNotificationPreferences.dailySummary,
      weeklySummary:
        payload.preferences.weeklySummary ??
        emailNotificationPreferences.weeklySummary,
      monthlySummary:
        payload.preferences.monthlySummary ??
        emailNotificationPreferences.monthlySummary,
    });
    setErrorMessage(null);

    setUser({
      ...user,
      email: payload.email ?? user.email,
      emailVerified: payload.emailVerified ?? user.emailVerified,
      emailNotificationsEnabled:
        payload.preferences.enabled ?? user.emailNotificationsEnabled,
      emailNotificationsRealtime:
        payload.preferences.realtime ?? user.emailNotificationsRealtime,
      emailNotificationsDailySummary:
        payload.preferences.dailySummary ?? user.emailNotificationsDailySummary,
      emailNotificationsWeeklySummary:
        payload.preferences.weeklySummary ??
        user.emailNotificationsWeeklySummary,
      emailNotificationsMonthlySummary:
        payload.preferences.monthlySummary ??
        user.emailNotificationsMonthlySummary,
    });
  };

  const handleSave = async () => {
    if (!user?.id) return;

    setSaving(true);
    setSaved(false);
    setErrorMessage(null);

    const trimmedDisplayName = (displayName ?? '').trim();
    const trimmedUsername = (username ?? '').trim();
    const trimmedBio = (bio ?? '').trim();

    // Backend now handles ALL signing automatically - no user popups!
    // This includes username changes, bio updates, display name changes.
    // The server signs the transaction on-chain for a seamless UX.

    const token = await getAccessToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let nextProfileImageUrl: string | null = null;
    let nextCoverImageUrl: string | null = null;

    // Upload images first (if any were changed).
    if (profileImage.file) {
      try {
        nextProfileImageUrl = await uploadImage(profileImage.file, 'profile');
      } catch (err) {
        logger.error(
          'Profile image upload request failed',
          { error: err },
          'SettingsPage'
        );
        setErrorMessage('Failed to upload profile image.');
        setSaving(false);
        return;
      }
    }

    if (coverImage.file) {
      try {
        nextCoverImageUrl = await uploadImage(coverImage.file, 'cover');
      } catch (err) {
        logger.error(
          'Cover image upload request failed',
          { error: err },
          'SettingsPage'
        );
        setErrorMessage('Failed to upload cover image.');
        setSaving(false);
        return;
      }
    }

    let response: Response;
    try {
      response = await fetch(
        apiUrl(`/api/users/${encodeURIComponent(user.id)}/update-profile`),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            displayName: trimmedDisplayName,
            username: trimmedUsername,
            bio: trimmedBio,
            ...(nextProfileImageUrl
              ? { profileImageUrl: nextProfileImageUrl }
              : {}),
            ...(nextCoverImageUrl ? { coverImageUrl: nextCoverImageUrl } : {}),
          }),
        }
      );
    } catch (err) {
      logger.error(
        'Profile update request failed',
        { error: err },
        'SettingsPage'
      );
      setErrorMessage('Unable to save your changes.');
      setSaving(false);
      return;
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error || 'Unable to save your changes.';
      setErrorMessage(message);
      logger.error(
        'Failed to save profile settings',
        { error: message },
        'SettingsPage'
      );
      setSaving(false);
      return;
    }

    if (payload.user) {
      setUser({
        ...user,
        username: payload.user.username,
        displayName: payload.user.displayName,
        bio: payload.user.bio,
        profileImageUrl: payload.user.profileImageUrl ?? user.profileImageUrl,
        coverImageUrl: payload.user.coverImageUrl ?? user.coverImageUrl,
        usernameChangedAt: payload.user.usernameChangedAt,
        referralCode: payload.user.referralCode,
      });
    }

    setProfileImage({ file: null, preview: null });
    setCoverImage({ file: null, preview: null });

    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    await refresh().catch(() => undefined);
    setSaving(false);
  };

  if (!ready) {
    return (
      <PageContainer
        noPadding
        className="overflow-x-clip! flex flex-col pt-14 md:pt-0"
      >
        <div className="min-h-full w-full border-border lg:border-r lg:border-l">
          {/* Header skeleton */}
          <div className="sticky top-14 z-10 bg-background/95 backdrop-blur-sm md:top-0">
            <div className="px-4 md:px-6">
              {/* Tab navigation skeleton */}
              <div className="flex gap-1 border-border border-b">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-20" />
                ))}
              </div>
            </div>
          </div>
          <div className="p-4 pb-[calc(1rem+var(--bottom-nav-height))] md:pb-4">
            {/* Form fields skeleton */}
            <div className="space-y-5 rounded-lg border border-border p-5">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-11 w-full rounded-lg" />
                </div>
              ))}
              <div className="border-border border-t pt-5">
                <Skeleton className="h-11 w-36 rounded-full" />
              </div>
            </div>
          </div>
        </div>
      </PageContainer>
    );
  }

  if (!authenticated) {
    return (
      <PageContainer
        noPadding
        className="overflow-x-clip! flex flex-col pt-14 md:pt-0"
      >
        <div className="min-h-full w-full border-border lg:border-r lg:border-l">
          <div className="px-4 py-12 pb-[calc(3rem+var(--bottom-nav-height))] text-center md:pb-12">
            <p className="mb-8 text-muted-foreground">
              Please sign in to access your settings.
            </p>
            <LoginButton />
          </div>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer
      noPadding
      className="overflow-x-clip! flex flex-col pt-14 md:pt-0"
    >
      <div className="min-h-full w-full border-border lg:border-r lg:border-l">
        {/* Sticky Header + Tab Navigation */}
        <div className="sticky top-14 z-10 bg-background/95 backdrop-blur-sm md:top-0">
          <div className="flex overflow-x-auto border-border border-b md:justify-center">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={cn(
                    'relative flex items-center gap-2 whitespace-nowrap px-8 py-3 font-medium text-sm transition-colors',
                    activeTab === tab.id
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                  {activeTab === tab.id && (
                    <div className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-4 pb-[calc(1rem+var(--bottom-nav-height))] md:pb-4">
          {/* Tab Content */}
          <div className="pt-6">
            {activeTab === 'profile' && (
              <div>
                <div className="space-y-5">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-sm">Profile</div>
                        <div className="text-muted-foreground text-xs">
                          Update your public info, images, and social accounts.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowLinkAccountsModal(true)}
                        className="flex min-h-[44px] items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted/30"
                      >
                        <LinkIcon className="h-4 w-4" />
                        Manage social accounts
                      </button>
                    </div>

                    <div className="relative mb-14 sm:mb-16">
                      {/* Cover Image */}
                      <div className="group relative h-32 overflow-hidden rounded-lg bg-muted sm:h-40">
                        {currentCoverImageUrl ? (
                          <img
                            src={currentCoverImageUrl}
                            alt="Cover"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="h-full w-full bg-gradient-to-br from-primary/20 to-primary/5" />
                        )}
                        <label className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/40 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                          <div className="rounded-full bg-background/90 p-2.5">
                            <Camera className="h-5 w-5" />
                          </div>
                          <input
                            type="file"
                            accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              handleImageSelect(file, 'cover');
                            }}
                          />
                        </label>
                      </div>

                      {/* Avatar - overlapping cover */}
                      <div className="absolute -bottom-12 left-3 sm:-bottom-14 sm:left-4">
                        <div className="group relative h-24 w-24 overflow-hidden rounded-full border-4 border-background bg-background sm:h-28 sm:w-28">
                          <Avatar
                            id={user?.id || ''}
                            name={user?.displayName || user?.email || 'User'}
                            type="user"
                            size="lg"
                            src={currentProfileImageUrl || undefined}
                            imageUrl={currentProfileImageUrl || undefined}
                            className="h-full w-full"
                          />
                          <label className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/40 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                            <div className="rounded-full bg-background/90 p-2">
                              <Camera className="h-4 w-4" />
                            </div>
                            <input
                              type="file"
                              accept="image/jpeg,image/jpg,image/png,image/webp,image/gif"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                handleImageSelect(file, 'profile');
                              }}
                            />
                          </label>
                        </div>
                      </div>
                    </div>

                    <p className="text-muted-foreground text-xs">
                      Hover over images to change. Max 5MB, JPG/PNG/GIF/WebP.
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="displayName"
                      className="mb-2 block font-medium text-muted-foreground text-sm"
                    >
                      Display Name
                    </label>
                    <input
                      id="displayName"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="min-h-[44px] w-full rounded-lg border border-border px-4 py-3 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30"
                      placeholder="Enter your display name"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="username"
                      className="mb-2 block font-medium text-muted-foreground text-sm"
                    >
                      Username
                    </label>
                    <input
                      id="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      disabled={Boolean(
                        usernameChangeLimit && !usernameChangeLimit.canChange
                      )}
                      className="min-h-[44px] w-full rounded-lg border border-border px-4 py-3 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
                      placeholder="Enter your username"
                    />
                    {usernameChangeLimit && !usernameChangeLimit.canChange ? (
                      <div className="mt-2 flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-3">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
                        <p className="text-xs text-yellow-500">
                          Username can only be changed once every 24 hours.
                          Please wait {usernameChangeLimit.hours}h{' '}
                          {usernameChangeLimit.minutes}m before changing again.
                        </p>
                      </div>
                    ) : (
                      <p className="mt-1 text-muted-foreground text-xs">
                        Username can be changed once every 24 hours. Changing
                        your username will update your referral code.
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="bio"
                      className="mb-2 block font-medium text-muted-foreground text-sm"
                    >
                      Bio
                    </label>
                    <textarea
                      id="bio"
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      rows={4}
                      className="min-h-[44px] w-full resize-none rounded-lg border border-border px-4 py-3 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30"
                      placeholder="Tell us about yourself..."
                    />
                  </div>

                  <div className="rounded-lg border border-border p-4">
                    <div className="mb-1 font-semibold text-sm">
                      Social visibility
                    </div>
                    <div className="text-muted-foreground text-xs">
                      Control what shows publicly on your profile.
                    </div>
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-sm">Twitter/X</div>
                          <div className="truncate text-muted-foreground text-xs">
                            {user?.hasTwitter && user?.twitterUsername
                              ? `@${user.twitterUsername}`
                              : 'Not linked'}
                          </div>
                        </div>
                        <Switch
                          checked={socialVisibility.twitter}
                          onCheckedChange={(checked) =>
                            void updateSocialVisibility('twitter', checked)
                          }
                          disabled={!user?.hasTwitter}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-sm">Farcaster</div>
                          <div className="truncate text-muted-foreground text-xs">
                            {user?.hasFarcaster && user?.farcasterUsername
                              ? `@${user.farcasterUsername}`
                              : 'Not linked'}
                          </div>
                        </div>
                        <Switch
                          checked={socialVisibility.farcaster}
                          onCheckedChange={(checked) =>
                            void updateSocialVisibility('farcaster', checked)
                          }
                          disabled={!user?.hasFarcaster}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border p-4">
                    <div className="mb-1 flex items-center gap-2 font-semibold text-sm">
                      <Bell className="h-4 w-4" />
                      Notification Emails
                    </div>
                    <div className="text-muted-foreground text-xs">
                      Choose which notifications you receive by email.
                    </div>
                    <div className="mt-2 text-muted-foreground text-xs">
                      {user?.email ? (
                        <>
                          Email:{' '}
                          <span className="font-medium">{user.email}</span> (
                          {user.emailVerified ? 'verified' : 'unverified'})
                        </>
                      ) : (
                        <div className="space-y-2">
                          <p>
                            No email linked yet. Enabling email notifications
                            requires a verified email.
                          </p>
                          <button
                            type="button"
                            onClick={() => setShowLinkAccountsModal(true)}
                            className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-border px-2.5 py-1.5 font-medium text-xs transition-colors hover:bg-muted/30"
                          >
                            <LinkIcon className="h-3.5 w-3.5" />
                            <span>Link my email</span>
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-sm">
                            Enable notification emails
                          </div>
                          <div className="truncate text-muted-foreground text-xs">
                            Master toggle for all email notifications.
                          </div>
                        </div>
                        <Switch
                          checked={emailNotificationPreferences.enabled}
                          onCheckedChange={(checked) =>
                            void updateEmailNotificationPreferences({
                              enabled: checked,
                            })
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-sm">Real-time</div>
                          <div className="truncate text-muted-foreground text-xs">
                            Immediate event-based notifications.
                          </div>
                        </div>
                        <Switch
                          checked={emailNotificationPreferences.realtime}
                          onCheckedChange={(checked) =>
                            void updateEmailNotificationPreferences({
                              realtime: checked,
                            })
                          }
                          disabled={!emailNotificationPreferences.enabled}
                        />
                      </div>
                    </div>
                    <div className="mt-3 text-muted-foreground text-xs">
                      Performance digest frequency and delivery are managed in
                      the Notifications tab. All notification emails include an
                      unsubscribe link.
                    </div>
                  </div>
                </div>

                {/* Save area */}
                <div className="mt-3">
                  {errorMessage && (
                    <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                      <p className="text-red-500 text-sm">{errorMessage}</p>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className={cn(
                        'flex min-h-[44px] items-center gap-2 px-6 py-3 font-medium transition-all',
                        'bg-primary text-primary-foreground hover:bg-primary/90',
                        'disabled:cursor-not-allowed disabled:opacity-50'
                      )}
                    >
                      <Save className="h-4 w-4" />
                      <span>
                        {saving
                          ? 'Saving...'
                          : saved
                            ? 'Saved!'
                            : 'Save Changes'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            <LinkSocialAccountsModal
              isOpen={showLinkAccountsModal}
              onClose={() => setShowLinkAccountsModal(false)}
            />

            {activeTab === 'theme' && (
              <div className="space-y-5">
                {!mounted ? (
                  <div className="flex items-center justify-center py-8">
                    <Skeleton className="h-32 w-full" />
                  </div>
                ) : (
                  <>
                    <div className="grid gap-3">
                      {themeOptions.map((option) => {
                        const Icon = option.icon;
                        const isSelected = theme === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => setTheme(option.value)}
                            className={cn(
                              'flex items-center gap-3 rounded-lg border p-4 text-left transition-all',
                              isSelected
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:bg-muted/30'
                            )}
                          >
                            <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                            <div className="flex-1">
                              <p className="font-medium">{option.label}</p>
                              <p className="text-muted-foreground text-sm">
                                {option.description}
                              </p>
                            </div>
                            {isSelected && (
                              <CheckCircle2 className="h-5 w-5 shrink-0 text-primary" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Notifications Tab */}
            {activeTab === 'notifications' && <NotificationsTab />}

            {/* Billing Tab - Feature Flagged */}
            {activeTab === 'billing' && billingEnabled && <BillingTab />}

            {/* Security Tab */}
            {activeTab === 'security' && <SecurityTab />}

            {/* Privacy Tab */}
            {activeTab === 'privacy' && <PrivacyTab />}

            {/* API Keys Tab */}
            {activeTab === 'api' && <ApiKeysTab />}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
