'use client';

import { logger } from '@babylon/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStewardAuthContext } from '@/components/providers/StewardAuthProvider';
import { useLoginModal } from '@/hooks/useLoginModal';
import {
  clearBrowserDevAuthSession,
  getBrowserDevAuthSession,
} from '@/lib/auth/dev-auth';
import { clearUserChatCache } from '@/lib/chat/message-store';
import { type User, useAuthStore } from '@/stores/authStore';
import { apiFetch } from '@/utils/api-fetch';
import {
  listStorageKeys,
  readStorageItem,
  removeStorageItem,
} from '@/utils/browser-storage';

/**
 * Return type for the useAuth hook.
 */
interface UseAuthReturn {
  /** Whether auth is ready (session checked) */
  ready: boolean;
  /** Whether the user is currently authenticated */
  authenticated: boolean;
  /** Whether the user profile is currently loading */
  loadingProfile: boolean;
  /** The current authenticated user, or null if not authenticated */
  user: User | null;
  /** Whether the user needs to complete onboarding */
  needsOnboarding: boolean;
  /** Whether the server has been consulted for profile status this session */
  profileFetchStatus: 'idle' | 'loading' | 'done' | 'error';
  /** Function to open the login modal */
  login: () => void;
  /** Function to logout and clear all auth state */
  logout: () => Promise<void>;
  /** Function to refresh the current user profile */
  refresh: () => Promise<void>;
  /** Function to get the current access token */
  getAccessToken: () => Promise<string | null>;
}

// Global fetch deduplication — shared across all useAuth instances
let globalFetchInFlight: Promise<void> | null = null;
let globalTokenRetryTimeout: number | null = null;

/**
 * Main authentication hook.
 *
 * Phase 2: Backed by Steward auth (StewardAuth SDK) instead of Privy.
 * Authentication state comes from the Steward session (localStorage-backed
 * JWT) and an httpOnly `steward-token` cookie set by /api/auth/session.
 *
 * Login opens the custom Steward LoginModal. Logout clears both the SDK
 * session and the server-side cookie.
 */
export function useAuth(): UseAuthReturn {
  const { stewardAuth, session } = useStewardAuthContext();
  const { showLoginModal } = useLoginModal();
  const {
    user,
    isLoadingProfile,
    needsOnboarding,
    profileFetchStatus,
    setUser,
    setNeedsOnboarding,
    setProfileFetchStatus,
    setLoadedUserId,
    setIsLoadingProfile,
    clearAuth,
  } = useAuthStore();
  const queryClient = useQueryClient();
  const [devAuthSession, setDevAuthSession] = useState(() =>
    getBrowserDevAuthSession()
  );
  const hasClearedAuthRef = useRef(false);

  const authenticated = devAuthSession
    ? true
    : session !== null && stewardAuth.isAuthenticated();
  const ready = true; // Steward SDK initializes synchronously from localStorage

  // ── Token access ─────────────────────────────────────────────────────────

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    if (devAuthSession) return devAuthSession.accessToken;
    return stewardAuth.getToken() ?? null;
  }, [devAuthSession, stewardAuth]);

  // TODO: Phase 3 — rename window.__privyAccessToken / __privyGetAccessToken
  // to window.__accessToken / __getAccessToken once all consumers have migrated.
  // Keep window-level token in sync for apiFetch legacy compatibility
  useEffect(() => {
    const token = stewardAuth.getToken();
    if (typeof window !== 'undefined') {
      (
        window as Window & { __privyAccessToken?: string | null }
      ).__privyAccessToken = token;
      (
        window as Window & {
          __privyGetAccessToken?: () => Promise<string | null>;
        }
      ).__privyGetAccessToken = getAccessToken;
    }
    return () => {
      if (typeof window !== 'undefined') {
        (
          window as Window & {
            __privyGetAccessToken?: () => Promise<string | null>;
          }
        ).__privyGetAccessToken = undefined;
      }
    };
  }, [getAccessToken, stewardAuth]);

  // ── Dev auth sync ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setDevAuthSession(getBrowserDevAuthSession());
    sync();
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  // ── Profile fetch (dev auth) ──────────────────────────────────────────────

  const fetchDevCurrentUser = useCallback(async () => {
    if (!devAuthSession) return;
    setIsLoadingProfile(true);
    setLoadedUserId(devAuthSession.userId);
    const response = await fetch('/api/users/me', {
      headers: { Authorization: `Bearer ${devAuthSession.accessToken}` },
      credentials: 'include',
    });
    if (!response.ok) {
      setIsLoadingProfile(false);
      return;
    }
    const data = (await response.json()) as {
      authenticated: boolean;
      needsOnboarding: boolean;
      user: User | null;
    };
    setNeedsOnboarding(data.needsOnboarding);
    if (data.user) {
      setUser({
        ...data.user,
        displayName:
          data.user.displayName?.trim() ||
          devAuthSession.displayName ||
          'Dev User',
        email: data.user.email ?? devAuthSession.email ?? undefined,
      });
    }
    setIsLoadingProfile(false);
  }, [
    devAuthSession,
    setIsLoadingProfile,
    setLoadedUserId,
    setNeedsOnboarding,
    setUser,
  ]);

  // ── Profile fetch (Steward) ───────────────────────────────────────────────

  const fetchCurrentUser = useCallback(
    async (retryCount = 0) => {
      if (!authenticated || !session) return;
      if (globalFetchInFlight) {
        await globalFetchInFlight;
        return;
      }

      const run = async () => {
        setIsLoadingProfile(true);
        setProfileFetchStatus('loading');
        setLoadedUserId(session.userId ?? session.address);

        const token = stewardAuth.getToken();
        if (!token) {
          if (retryCount >= 5) {
            logger.error(
              'Steward token unavailable after max retries',
              { retryCount },
              'useAuth'
            );
            setIsLoadingProfile(false);
            return;
          }
          setIsLoadingProfile(false);
          if (typeof window !== 'undefined') {
            if (globalTokenRetryTimeout)
              window.clearTimeout(globalTokenRetryTimeout);
            globalTokenRetryTimeout = window.setTimeout(
              () => void fetchCurrentUser(retryCount + 1),
              200 * (retryCount + 1)
            );
          }
          return;
        }

        const referralCode =
          typeof window !== 'undefined'
            ? readStorageItem('sessionStorage', 'referralCode')
            : null;
        const url = referralCode
          ? `/api/users/me?ref=${encodeURIComponent(referralCode)}`
          : '/api/users/me';

        let response: Response;
        try {
          response = await apiFetch(url);
        } catch (networkError) {
          logger.warn(
            'Failed to reach /api/users/me — keeping persisted auth state',
            {
              error:
                networkError instanceof Error
                  ? networkError.message
                  : String(networkError),
            },
            'useAuth'
          );
          setProfileFetchStatus('error');
          setIsLoadingProfile(false);
          return;
        }

        if (response.status === 401) {
          setProfileFetchStatus('error');
          setIsLoadingProfile(false);
          return;
        }

        if (!response.ok) {
          logger.warn(
            'Non-OK response from /api/users/me — keeping persisted auth state',
            { status: response.status },
            'useAuth'
          );
          setProfileFetchStatus('error');
          setIsLoadingProfile(false);
          return;
        }

        const data = (await response.json()) as {
          authenticated: boolean;
          needsOnboarding: boolean;
          user: User | null;
        };

        setNeedsOnboarding(data.needsOnboarding ?? false);
        setProfileFetchStatus('done');

        if (data.user) {
          setUser(data.user);
        } else {
          // Session valid but no profile yet — set minimal user
          const currentUser = useAuthStore.getState().user;
          if (!currentUser) {
            setUser({
              id: session.userId ?? session.address,
              displayName: session.email ?? 'Anonymous',
              email: session.email ?? undefined,
            });
          }
        }

        setIsLoadingProfile(false);
      };

      const promise = run().finally(() => {
        globalFetchInFlight = null;
        if (typeof window !== 'undefined' && globalTokenRetryTimeout) {
          window.clearTimeout(globalTokenRetryTimeout);
          globalTokenRetryTimeout = null;
        }
      });
      globalFetchInFlight = promise;
      await promise;
    },
    [
      authenticated,
      session,
      stewardAuth,
      setIsLoadingProfile,
      setProfileFetchStatus,
      setLoadedUserId,
      setNeedsOnboarding,
      setUser,
    ]
  );

  // ── Auth state changes ────────────────────────────────────────────────────

  useEffect(() => {
    if (devAuthSession) {
      hasClearedAuthRef.current = false;
      void fetchDevCurrentUser();
      return;
    }

    if (!authenticated) {
      if (hasClearedAuthRef.current) return;
      useAuthStore.getState().clearAuth();
      hasClearedAuthRef.current = true;

      // Clear stale Steward session keys from localStorage
      if (typeof window !== 'undefined') {
        const stewardKeys = listStorageKeys('localStorage').filter(
          (key) => key.startsWith('steward:') || key.startsWith('stwd-')
        );
        stewardKeys.forEach((key) => removeStorageItem('localStorage', key));
      }
      return;
    }

    hasClearedAuthRef.current = false;
    void fetchCurrentUser();
  }, [authenticated, devAuthSession, fetchCurrentUser, fetchDevCurrentUser]);

  // ── Cleanup ───────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && globalTokenRetryTimeout) {
        window.clearTimeout(globalTokenRetryTimeout);
        globalTokenRetryTimeout = null;
      }
    };
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────

  const refresh = async () => {
    if (devAuthSession) {
      await fetchDevCurrentUser();
      return;
    }
    if (!authenticated) return;
    await fetchCurrentUser();
  };

  const handleLogin = useCallback(() => {
    showLoginModal();
  }, [showLoginModal]);

  const handleLogout = async () => {
    const logoutUserId = user?.id;
    queryClient.clear();
    if (logoutUserId) void clearUserChatCache(logoutUserId);

    if (devAuthSession) {
      clearBrowserDevAuthSession();
      setDevAuthSession(null);
      clearAuth();
      if (typeof window !== 'undefined') {
        (
          window as Window & { __privyAccessToken?: string | null }
        ).__privyAccessToken = null;
        localStorage.removeItem('babylon-auth');
      }
      globalFetchInFlight = null;
      if (globalTokenRetryTimeout !== null) {
        clearTimeout(globalTokenRetryTimeout);
        globalTokenRetryTimeout = null;
      }
      return;
    }

    // Sign out from Steward SDK (clears localStorage token)
    stewardAuth.signOut();

    // Clear the httpOnly cookie via the session API
    await fetch('/api/auth/session', {
      method: 'DELETE',
      credentials: 'include',
    }).catch(() => {
      // Non-critical — cookie will expire naturally
    });

    clearAuth();

    if (typeof window !== 'undefined') {
      (
        window as Window & { __privyAccessToken?: string | null }
      ).__privyAccessToken = null;
      removeStorageItem('localStorage', 'babylon-auth');
    }

    globalFetchInFlight = null;
    if (globalTokenRetryTimeout !== null) {
      clearTimeout(globalTokenRetryTimeout);
      globalTokenRetryTimeout = null;
    }

    logger.info(
      'User logged out and all auth state cleared',
      undefined,
      'useAuth'
    );
  };

  return {
    ready,
    authenticated,
    loadingProfile: isLoadingProfile,
    user,
    needsOnboarding,
    profileFetchStatus: devAuthSession ? 'done' : profileFetchStatus,
    login: handleLogin,
    logout: handleLogout,
    refresh,
    getAccessToken,
  };
}
