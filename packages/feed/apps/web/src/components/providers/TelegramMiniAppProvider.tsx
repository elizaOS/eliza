'use client';

import { logger } from '@babylon/shared';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useStewardAuthContext } from './StewardAuthProvider';

/**
 * Telegram Mini App Provider.
 *
 * Phase 2: Auto-authenticates via /api/auth/telegram-miniapp (HMAC-verified
 * initData) instead of Privy's loginWithTelegram.
 *
 * Flow:
 * 1. Detect Telegram Mini App context via @telegram-apps/sdk-react
 * 2. Extract initData from launch params
 * 3. POST initData to /api/auth/telegram-miniapp for HMAC verification
 * 4. Receive a Steward-compatible JWT back and call onLoginSuccess()
 */

interface TelegramUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
}

interface TelegramMiniAppContextType {
  isMiniApp: boolean;
  isLoading: boolean;
  error?: string;
  user: TelegramUser | null;
  share: (url: string, text?: string) => void;
  close: () => void;
  linkAccount: () => boolean;
}

const TelegramMiniAppContext = createContext<TelegramMiniAppContextType | null>(
  null
);

export function useTelegramMiniApp() {
  const context = useContext(TelegramMiniAppContext);
  if (!context)
    throw new Error(
      'useTelegramMiniApp must be used within TelegramMiniAppProvider'
    );
  return context;
}

export function TelegramMiniAppProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { onLoginSuccess } = useStewardAuthContext();
  const [isMiniApp, setIsMiniApp] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [telegramUser, setTelegramUser] = useState<TelegramUser | null>(null);

  const hasInitialized = useRef(false);
  const hasAttemptedLogin = useRef(false);
  const sdkRef = useRef<typeof import('@telegram-apps/sdk-react') | null>(null);
  const initDataRawRef = useRef<string | null>(null);

  // ── Detect & Initialize ───────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === 'undefined' || hasInitialized.current) return;
    hasInitialized.current = true;

    const initialize = async () => {
      try {
        const sdk = await import('@telegram-apps/sdk-react');
        sdkRef.current = sdk;

        const isTelegramEnv = await sdk.isTMA('complete');
        if (!isTelegramEnv) {
          setIsLoading(false);
          return;
        }

        sdk.init();
        if (sdk.miniApp.mountSync.isAvailable()) sdk.miniApp.mountSync();
        if (sdk.miniApp.isMounted() && sdk.miniApp.bindCssVars.isAvailable())
          sdk.miniApp.bindCssVars();
        if (sdk.viewport.mount.isAvailable()) await sdk.viewport.mount();
        if (sdk.viewport.expand.isAvailable()) sdk.viewport.expand();
        if (sdk.themeParams.mountSync.isAvailable())
          sdk.themeParams.mountSync();
        if (sdk.themeParams.bindCssVars.isAvailable())
          sdk.themeParams.bindCssVars();

        const lp = sdk.retrieveLaunchParams();
        const rawInitData = (lp as Record<string, unknown>).tgWebAppDataRaw as
          | string
          | undefined;
        initDataRawRef.current = rawInitData ?? null;

        // Extract user from client-side launch data for display
        const initData = (lp as Record<string, unknown>)?.tgWebAppData as
          | { user?: Record<string, unknown> }
          | undefined;
        if (initData?.user) {
          const u = initData.user;
          setTelegramUser({
            id: Number(u.id),
            firstName: String(u.firstName ?? u.first_name ?? ''),
            lastName:
              u.lastName != null || u.last_name != null
                ? String(u.lastName ?? u.last_name)
                : undefined,
            username: u.username != null ? String(u.username) : undefined,
            photoUrl:
              u.photoUrl != null || u.photo_url != null
                ? String(u.photoUrl ?? u.photo_url)
                : undefined,
          });
        }

        setIsMiniApp(true);
        if (sdk.miniApp.ready.isAvailable()) sdk.miniApp.ready();

        logger.info(
          'Telegram Mini App initialized',
          { user: initData?.user?.username },
          'TelegramMiniApp'
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          'Telegram Mini App initialization failed',
          { error: message },
          'TelegramMiniApp'
        );
        setError(message);
      } finally {
        setIsLoading(false);
      }
    };

    void initialize();
  }, []);

  // ── Seamless auto-login via /api/auth/telegram-miniapp ────────────────────

  useEffect(() => {
    if (!isMiniApp || isLoading || hasAttemptedLogin.current) return;
    if (!initDataRawRef.current) return;
    hasAttemptedLogin.current = true;

    const attemptLogin = async () => {
      logger.info(
        'Attempting Telegram Mini App auto-login',
        { userId: telegramUser?.id },
        'TelegramMiniApp'
      );

      const res = await fetch('/api/auth/telegram-miniapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ initData: initDataRawRef.current }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        token?: string;
        error?: string;
      };
      if (!data.ok || !data.token) {
        throw new Error(data.error ?? 'Telegram miniapp auth failed');
      }

      await onLoginSuccess(data.token);
      logger.info(
        'Telegram Mini App login successful',
        { userId: telegramUser?.id },
        'TelegramMiniApp'
      );
    };

    attemptLogin().catch((err: Error) => {
      logger.error(
        'Telegram Mini App auto-login failed',
        { error: err.message },
        'TelegramMiniApp'
      );
      setError(err.message);
    });
  }, [isMiniApp, isLoading, telegramUser?.id, onLoginSuccess]);

  // ── Back button ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isMiniApp || !sdkRef.current) return;
    const sdk = sdkRef.current;
    if (sdk.backButton.mount.isAvailable()) sdk.backButton.mount();
    const handler = () => {
      if (typeof window !== 'undefined') window.history.back();
    };
    if (sdk.backButton.onClick.isAvailable()) sdk.backButton.onClick(handler);
    const updateVisibility = () => {
      const isRoot =
        window.location.pathname === '/' || window.location.pathname === '';
      if (isRoot) {
        if (sdk.backButton.hide.isAvailable()) sdk.backButton.hide();
      } else {
        if (sdk.backButton.show.isAvailable()) sdk.backButton.show();
      }
    };
    updateVisibility();
    window.addEventListener('popstate', updateVisibility);
    return () => {
      window.removeEventListener('popstate', updateVisibility);
      if (sdk.backButton.offClick.isAvailable())
        sdk.backButton.offClick(handler);
      if (sdk.backButton.hide.isAvailable()) sdk.backButton.hide();
    };
  }, [isMiniApp]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const share = (url: string, text?: string) => {
    if (!isMiniApp || !sdkRef.current) return;
    const sdk = sdkRef.current;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}${text ? `&text=${encodeURIComponent(text)}` : ''}`;
    if (sdk.openTelegramLink.isAvailable()) sdk.openTelegramLink(shareUrl);
    else if (typeof window !== 'undefined') window.open(shareUrl, '_blank');
  };

  const close = () => {
    if (!isMiniApp || !sdkRef.current) return;
    const sdk = sdkRef.current;
    if (sdk.miniApp.close.isAvailable()) sdk.miniApp.close();
  };

  const linkAccount = (): boolean => {
    // Phase 2: Telegram linking handled at login time via initData HMAC
    if (!isMiniApp || !initDataRawRef.current) return false;
    logger.info(
      'Telegram linkAccount: re-triggering login flow',
      { userId: telegramUser?.id },
      'TelegramMiniApp'
    );
    return true;
  };

  return (
    <TelegramMiniAppContext.Provider
      value={{
        isMiniApp,
        isLoading,
        error,
        user: telegramUser,
        share,
        close,
        linkAccount,
      }}
    >
      {children}
    </TelegramMiniAppContext.Provider>
  );
}
